import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

// Pago combinado (saldo a favor + MP/transferencia): IMPORTE FISCAL DE LA NC
// ≠ DINERO EXTERNO ≠ SALDO A RESTAURAR (20261014130000). RPCs REALES:
// begin_partial_credit_note (reparto), commit_order_refund_proof (reintegro
// externo), reverse_customer_credit_for_order y la restauración por NC.
// Sin ARCA, Mercado Pago ni datos reales.

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8").replace(/\r\n/g, "\n")
const block = (source: string, start: string) => {
  const from = source.indexOf(start)
  return source.slice(from, source.indexOf("$$;", source.indexOf("as $$", from)) + 3)
}

const admin = "10000000-0000-4000-8000-000000000003"
const customer = "10000000-0000-4000-8000-000000000001"

async function setup() {
  const db = new PGlite()
  await db.exec(read("lib/orders/fixtures/claim-schema.sql"))
  for (const path of [
    "supabase/migrations/20260816120000_atomic_order_claim_cancellation.sql",
    "supabase/migrations/20260905150000_claims_atomic_operations.sql",
    "supabase/migrations/20260906090000_claim_case_type_transitions.sql",
    "supabase/migrations/20260906100000_claims_final_security.sql",
    "supabase/migrations/20260906110000_claim_credit_note_snapshot.sql",
    "supabase/migrations/20260917120000_credit_note_refundable_external_cap.sql",
  ]) await db.exec(read(path))
  await db.exec(`
    alter table ordenes add column invoice_queued_at timestamptz, add column original_total numeric,
      add column credit_balance_movement_id uuid, add column payment_composition jsonb not null default '{}',
      add column payment_method_id text;
    alter table order_refund_proofs add column observation text, add column bank_reference text, add column refund_date date;
    alter table customer_credit_movements add column user_id uuid, add column amount numeric(12,2), add column description text,
      add column source_id text, add column created_by uuid, add column related_movement_id uuid, add column source_key text unique,
      add column resulting_balance numeric(12,2), add column metadata jsonb, add column credit_note_id text;
    create function get_customer_credit_balance(p_user uuid) returns numeric language sql stable as $$
      select coalesce(sum(case when movement_type in ('credit','reversal','adjustment') then amount else -amount end), 0)
      from customer_credit_movements where user_id = p_user $$;
  `)
  const obligation = read("supabase/migrations/20261014100000_invoice_obligation_survives_cancellation.sql")
  await db.exec(block(obligation, "create or replace function public.order_has_admin_direct_cancellation("))
  const refundPolicy = read("supabase/migrations/20260917130000_external_refund_without_credit_note_and_mp_nc_policy.sql")
  await db.exec(block(refundPolicy, "create or replace function public.commit_order_refund_proof("))
  await db.exec(read("supabase/migrations/20261014120000_customer_credit_reversal_after_credit_note.sql"))
  await db.exec(read("supabase/migrations/20261014130000_credit_note_fiscal_vs_money_split.sql"))
  await db.query("select set_config('request.jwt.claim.role','service_role',false)")
  await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ role: "service_role" })])
  await db.query("insert into auth.users values($1,'a@example.test',now()),($2,'c@example.test',now())", [admin, customer])
  await db.query("insert into profiles(id,email,rol) values($1,'a@example.test','admin'),($2,'c@example.test','cliente')", [admin, customer])
  return db
}

/** Venta facturada de $100.000 cancelada por Admin: `external` cobrado afuera, el resto con saldo. */
async function cancelledInvoicedSale(db: PGlite, id: number, external: number, method: "mercadopago" | "transferencia") {
  const credit = 100000 - external
  await db.query(`insert into ordenes(id,usuario_id,estado,total,original_total,invoice_status,invoice_cae,invoice_number,invoice_point,
      payment_confirmed_amount,external_amount_due,credit_balance_used,financial_status,payment_method_id,invoice_queued_at,credit_note_required)
    values ($1,$2,'cancelado',100000,100000,'authorized','CAE',$3,1,$4,$5,$6,'refund_pending',$7,now(),true)`,
    [id, customer, id, external, external, credit, method])
  await db.query(`insert into order_audit_events(order_id,actor_type,action,metadata)
    values ($1,'admin','order_cancelled_refund_pending','{"source":"admin_direct_cancellation"}'::jsonb)`, [id])
  // Lo que hace la cancelación: pide la reversión del saldo (queda retenida).
  await db.query("select * from reverse_customer_credit_for_order($1,'Cancelación',$2)", [id, admin])
}

type Note = { id: string; total_amount: string; external_amount: string; customer_credit_amount: string }
async function reserveNote(db: PGlite, id: number, amount: number, destination = "external_refund") {
  return (await db.query<Note>(
    `select id,total_amount,external_amount,customer_credit_amount from begin_partial_credit_note($1::bigint,null,$2,'Cancelación aprobada',0,
      $3::numeric,$3::numeric,1,$1::bigint,$4::uuid,'[]','cancelacion_antes_despacho')`,
    [id, destination, amount, admin],
  )).rows[0]
}
const authorize = (db: PGlite, noteId: string) =>
  db.query("update order_credit_notes set status='authorized', cae='CAE-NC' where id=$1", [noteId])
const split = (note: Note) => [Number(note.total_amount), Number(note.external_amount), Number(note.customer_credit_amount)]
const restoredCredit = async (db: PGlite, id: number) => Number((await db.query<{ s: string }>(
  "select coalesce(sum(amount),0) s from customer_credit_movements where order_id=$1 and movement_type='reversal'", [id])).rows[0].s)
const restorations = async (db: PGlite, id: number) => Number((await db.query<{ n: number }>(
  "select count(*)::int n from customer_credit_movements where order_id=$1 and movement_type='reversal'", [id])).rows[0].n)

async function commitTransferProof(db: PGlite, id: number, noteIds: string[]) {
  const path = `proof-${id}-${randomUUID()}.jpg`
  const operationId = randomUUID()
  await db.query(`insert into order_claim_operations (id, actor_id, order_id, request_key, status, file_paths, bucket_id)
    values ($1, $2, $3, $4, 'uploading', $5, 'payment-proofs')`, [operationId, admin, id, randomUUID().replace(/-/g, "").repeat(2), [path]])
  await db.query("insert into storage.objects (bucket_id, name) values ('payment-proofs', $1)", [path])
  return db.query("select * from commit_order_refund_proof($1, $2, $3::jsonb)",
    [operationId, admin, JSON.stringify({ path, name: "c.jpg", type: "image/jpeg", size: 1024, expected_note_ids: [...noteIds].sort() })])
}

test("1. $70.000 MP + $30.000 saldo: NC $100.000 → $70.000 externos (MP) y $30.000 de saldo restaurado una vez", async () => {
  const db = await setup()
  try {
    await cancelledInvoicedSale(db, 1, 70000, "mercadopago")
    assert.equal(await restoredCredit(db, 1), 0, "cancelar no devuelve el saldo antes de la NC")
    const note = await reserveNote(db, 1, 100000)
    assert.deepEqual(split(note), [100000, 70000, 30000], "fiscal $100.000 = $70.000 externo + $30.000 saldo")
    assert.equal(await restoredCredit(db, 1), 0, "NC en proceso: todavía nada")
    await authorize(db, note.id)
    assert.equal(await restoredCredit(db, 1), 30000)
    const order = (await db.query<{ credit_balance_used: string; payment_confirmed_amount: string }>(
      "select credit_balance_used, payment_confirmed_amount from ordenes where id=1")).rows[0]
    assert.equal(Number(order.credit_balance_used), 0)
    // El refund real de MP devuelve payment_confirmed_amount = la parte externa de la NC.
    assert.equal(Number(order.payment_confirmed_amount), Number(note.external_amount))
  } finally { await db.close() }
})

test("2. $70.000 transferencia + $30.000 saldo: el comprobante liquida $70.000 (no el total fiscal) y vuelven $30.000 de saldo", async () => {
  const db = await setup()
  try {
    await cancelledInvoicedSale(db, 2, 70000, "transferencia")
    const note = await reserveNote(db, 2, 100000)
    await authorize(db, note.id)
    await commitTransferProof(db, 2, [note.id])
    const proof = (await db.query<{ amount: string }>("select amount from order_refund_proofs where order_id=2")).rows
    assert.deepEqual(proof.map((row) => Number(row.amount)), [70000])
    const order = (await db.query<{ financial_status: string; refund_amount: string }>("select financial_status, refund_amount from ordenes where id=2")).rows[0]
    assert.equal(order.financial_status, "refunded")
    assert.equal(Number(order.refund_amount), 70000)
    assert.equal(await restoredCredit(db, 2), 30000)
  } finally { await db.close() }
})

test("3. cancelación parcial: cada NC reparte proporcionalmente y la que cierra la factura toma el resto", async () => {
  const db = await setup()
  try {
    await cancelledInvoicedSale(db, 3, 70000, "transferencia")
    const first = await reserveNote(db, 3, 33333.33)
    assert.deepEqual(split(first), [33333.33, 23333.33, 10000], "30% del importe es saldo")
    await authorize(db, first.id)
    assert.equal(await restoredCredit(db, 3), 10000, "restaura sólo la parte de esta NC")
    const second = await reserveNote(db, 3, 66666.67)
    assert.deepEqual(split(second), [66666.67, 46666.67, 20000], "la NC final cierra exacto")
    await authorize(db, second.id)
    assert.equal(await restoredCredit(db, 3), 30000)
    const external = Number(first.external_amount) + Number(second.external_amount)
    assert.equal(Math.round(external * 100), 7000000, "externo total = $70.000")
  } finally { await db.close() }
})

test("4. sólo saldo: NC $100.000 sin dinero externo y saldo restaurado completo", async () => {
  const db = await setup()
  try {
    await cancelledInvoicedSale(db, 4, 0, "transferencia")
    const note = await reserveNote(db, 4, 100000, "customer_balance")
    assert.deepEqual(split(note), [100000, 0, 100000])
    await authorize(db, note.id)
    assert.equal(await restoredCredit(db, 4), 100000)
  } finally { await db.close() }
})

test("5. sólo MP/transferencia: la NC es toda dinero externo, sin restauración de saldo (sin regresión)", async () => {
  const db = await setup()
  try {
    await cancelledInvoicedSale(db, 5, 100000, "transferencia")
    const note = await reserveNote(db, 5, 100000)
    assert.deepEqual(split(note), [100000, 100000, 0])
    await authorize(db, note.id)
    assert.equal(await restorations(db, 5), 0)
    await commitTransferProof(db, 5, [note.id])
    assert.deepEqual((await db.query<{ amount: string }>("select amount from order_refund_proofs where order_id=5")).rows.map((r) => Number(r.amount)), [100000])
  } finally { await db.close() }
})

test("6. reintentos: no duplica NC, reintegro externo ni saldo", async () => {
  const db = await setup()
  try {
    await cancelledInvoicedSale(db, 6, 70000, "transferencia")
    const note = await reserveNote(db, 6, 100000)
    await assert.rejects(reserveNote(db, 6, 100000), /CREDIT_NOTE_PROCESSING_IN_PROGRESS/)
    await authorize(db, note.id)
    await authorize(db, note.id)
    await assert.rejects(reserveNote(db, 6, 1), /CREDIT_NOTE_EXCEEDS_INVOICE/, "la factura ya está totalmente acreditada")
    await db.query("select * from reverse_customer_credit_for_order(6,'Cancelación',$1)", [admin])
    await commitTransferProof(db, 6, [note.id])
    await assert.rejects(commitTransferProof(db, 6, [note.id]), /CLAIM_REFUND_PENDING/)
    assert.equal(await restorations(db, 6), 1)
    assert.equal(await restoredCredit(db, 6), 30000)
    assert.equal(Number((await db.query<{ n: number }>("select count(*)::int n from order_refund_proofs where order_id=6")).rows[0].n), 1)
  } finally { await db.close() }
})

test("7. error de ARCA: sin NC autorizada no se mueve dinero ni saldo", async () => {
  const db = await setup()
  try {
    await cancelledInvoicedSale(db, 7, 70000, "transferencia")
    const note = await reserveNote(db, 7, 100000)
    await db.query("update order_credit_notes set status='error' where id=$1", [note.id])
    await assert.rejects(commitTransferProof(db, 7, [note.id]), /CLAIM_REFUND_PENDING/)
    await db.query("select * from reverse_customer_credit_for_order(7,'Cancelación',$1)", [admin])
    assert.equal(await restorations(db, 7), 0)
    assert.equal(Number((await db.query<{ n: number }>("select count(*)::int n from order_refund_proofs where order_id=7")).rows[0].n), 0)
  } finally { await db.close() }
})
