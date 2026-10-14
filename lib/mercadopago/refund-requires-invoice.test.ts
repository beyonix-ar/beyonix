import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

import { getCancellationNextAction } from "../orders/cancellation-next-action.ts"

// Regla única: pago confirmado → Factura C → NC C → dinero. Ejercita las RPCs
// REALES que devuelven dinero (begin_mercadopago_order_refund: botón de MP y
// reclamos; commit_order_refund_proof: comprobante manual/modo avanzado y
// reclamos) con el guard de 20261014110000. Sin red ni Mercado Pago real.

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8").replace(/\r\n/g, "\n")
const admin = "10000000-0000-4000-8000-000000000003"
const customer = "10000000-0000-4000-8000-000000000001"

async function setup() {
  const db = new PGlite()
  await db.exec(read("lib/mercadopago/fixtures/refund-without-credit-note.sql"))
  await db.exec(read("supabase/migrations/20260917130000_external_refund_without_credit_note_and_mp_nc_policy.sql"))
  await db.exec(`alter table public.ordenes add column invoice_queued_at timestamptz,
    add column invoice_status text, add column invoice_cae text`)
  await db.exec(read("supabase/migrations/20261014110000_refund_requires_invoice_first.sql"))
  await db.query("select set_config('request.jwt.claim.role','service_role',false)")
  await db.query("insert into auth.users(id) values($1),($2)", [admin, customer])
  await db.query("insert into public.profiles(id,rol) values($1,'admin'),($2,'cliente')", [admin, customer])
  return db
}

type Fiscal = "pending" | "invoiced" | "unpaid"

async function insertOrder(db: PGlite, id: number, method: "mercadopago" | "transferencia", fiscal: Fiscal) {
  await db.query(
    `insert into ordenes (id, usuario_id, total, payment_method_id, payment_id, payment_confirmed_amount, financial_status,
       estado, credit_note_required, invoice_queued_at, invoice_status, invoice_cae)
     values ($1,$2,30000,$3,$4,30000,'refund_pending','cancelado',false,$5,$6,$7)`,
    [id, customer, method, method === "mercadopago" ? `MP-${id}` : null,
      fiscal === "unpaid" ? null : new Date().toISOString(),
      fiscal === "invoiced" ? "authorized" : fiscal === "pending" ? "pending" : null,
      fiscal === "invoiced" ? "CAE-1" : null],
  )
}

const beginMpRefund = (db: PGlite, id: number) =>
  db.query<{ should_call_mp: boolean; status: string }>("select * from begin_mercadopago_order_refund($1, $2)", [id, admin])

async function commitProof(db: PGlite, id: number) {
  const path = `proof-${id}-${randomUUID()}.jpg`
  const operationId = randomUUID()
  await db.query(`insert into order_claim_operations (id, actor_id, order_id, request_key, status, file_paths, bucket_id)
    values ($1, $2, $3, $4, 'uploading', $5, 'payment-proofs')`, [operationId, admin, id, randomUUID(), [path]])
  await db.query("insert into storage.objects (bucket_id, name) values ('payment-proofs', $1)", [path])
  return db.query("select * from commit_order_refund_proof($1, $2, $3::jsonb)",
    [operationId, admin, JSON.stringify({ path, name: "c.jpg", type: "image/jpeg", size: 1024 })])
}

const count = async (db: PGlite, table: string, id: number) =>
  Number((await db.query<{ n: number }>(`select count(*)::int n from ${table} where order_id=$1`, [id])).rows[0].n)
const financial = async (db: PGlite, id: number) =>
  (await db.query<{ financial_status: string }>("select financial_status from ordenes where id=$1", [id])).rows[0].financial_status

test("1. pagado sin Factura C: ni el refund de MP ni el comprobante manual mueven dinero (primero factura)", async () => {
  const db = await setup()
  try {
    await insertOrder(db, 1, "mercadopago", "pending")
    await assert.rejects(beginMpRefund(db, 1), /INVOICE_REQUIRED_BEFORE_REFUND/)
    assert.equal(await count(db, "mercadopago_order_refunds", 1), 0, "nunca se llega a llamar a Mercado Pago")

    await insertOrder(db, 2, "transferencia", "pending")
    await assert.rejects(commitProof(db, 2), /INVOICE_REQUIRED_BEFORE_REFUND/)
    assert.equal(await count(db, "order_refund_proofs", 2), 0)
    assert.equal(await financial(db, 2), "refund_pending", "el pedido no queda reintegrado")
  } finally { await db.close() }
})

test("2. pagado y facturado: exige la NC antes del dinero; con la NC emitida el reintegro avanza", async () => {
  const db = await setup()
  try {
    await insertOrder(db, 1, "mercadopago", "invoiced")
    await db.query("update ordenes set credit_note_required=true where id=1")
    await assert.rejects(beginMpRefund(db, 1), /CREDIT_NOTE_REQUIRED/)
    // NC emitida (el flujo de NC deja credit_note_required=false).
    await db.query("update ordenes set credit_note_required=false where id=1")
    assert.equal((await beginMpRefund(db, 1)).rows[0].should_call_mp, true)

    await insertOrder(db, 2, "transferencia", "invoiced")
    const committed = await commitProof(db, 2)
    assert.equal(committed.rows.length, 1)
    assert.equal(await financial(db, 2), "refunded")
  } finally { await db.close() }
})

test("3. sin pago confirmado: no hay obligación de factura ni NC (el guard no interviene)", async () => {
  const db = await setup()
  try {
    await insertOrder(db, 1, "transferencia", "unpaid")
    assert.equal((await db.query<{ ok: boolean }>("select order_has_pending_invoice_obligation(1) ok")).rows[0].ok, false)
    await db.query(`insert into order_refund_proofs (order_id, file_name, file_path, mime_type, file_size, amount, method)
      values (1, 'c.jpg', 'payment-proofs/c.jpg', 'image/jpeg', 1, 1, 'test')`)
    assert.equal(await count(db, "order_refund_proofs", 1), 1)
  } finally { await db.close() }
})

test("4/5. ARCA falla: la obligación sigue y nada se mueve; al emitirse la factura, reintentar es idempotente", async () => {
  const db = await setup()
  try {
    await insertOrder(db, 1, "mercadopago", "pending")
    // ARCA rechazó/cayó: la factura queda en error con reintento.
    await db.query("update ordenes set invoice_status='error' where id=1")
    await assert.rejects(beginMpRefund(db, 1), /INVOICE_REQUIRED_BEFORE_REFUND/)
    await assert.rejects(beginMpRefund(db, 1), /INVOICE_REQUIRED_BEFORE_REFUND/)
    assert.equal(await count(db, "mercadopago_order_refunds", 1), 0, "los intentos bloqueados no dejan filas a medias")

    // Factura emitida; NC emitida → recién ahí el reintegro.
    await db.query("update ordenes set invoice_status='authorized', invoice_cae='CAE-2', credit_note_required=true where id=1")
    await assert.rejects(beginMpRefund(db, 1), /CREDIT_NOTE_REQUIRED/)
    await db.query("update ordenes set credit_note_required=false where id=1")
    assert.equal((await beginMpRefund(db, 1)).rows[0].should_call_mp, true)
    // Reintento del mismo reintegro: no hay un segundo intento ni un segundo POST.
    const retry = (await beginMpRefund(db, 1)).rows[0]
    assert.equal(retry.should_call_mp, false)
    assert.equal(await count(db, "mercadopago_order_refunds", 1), 1)
  } finally { await db.close() }
})

test("UI: con la Factura C pendiente la próxima acción es facturar, no reintegrar", () => {
  const base = {
    estado: "cancelado", financial_status: "refund_pending", payment_method_id: "mercadopago",
    paid_at: "2026-10-13T22:30:30Z", total: 1000, credit_note_required: false,
    order_credit_notes: [], mercadopago_order_refunds: [],
  }
  assert.deepEqual(getCancellationNextAction({ ...base, invoice_queued_at: "2026-10-13T22:30:31Z", invoice_status: "pending" }),
    { state: "blocked", urgent: true, reason: "invoice_missing" })
  // Sin obligación (nunca se encoló) o ya facturada: el camino existente.
  assert.equal(getCancellationNextAction({ ...base, invoice_queued_at: null }).state, "execute_mp_refund")
  assert.equal(getCancellationNextAction({ ...base, invoice_queued_at: "2026-10-13T22:30:31Z", invoice_status: "authorized",
    invoice_cae: "CAE", credit_note_required: true }).state, "emit_credit_note")
})

test("todos los caminos que devuelven dinero pasan por los puntos protegidos", () => {
  const mpRoute = read("app/api/admin/pedidos/[id]/mercadopago-refund/route.ts")
  assert.match(mpRoute, /executeFinancialResolution\(auth\.admin, orderId/, "botón de MP → resolución (Factura C → NC → dinero)")
  const claimServer = read("lib/orders/claim-server.ts")
  assert.match(claimServer, /rpc\("commit_order_refund_proof"/, "comprobante manual y reclamos → commit_order_refund_proof")
  assert.match(claimServer, /INVOICE_REQUIRED_BEFORE_REFUND: \[409,/)
  const refunds = read("lib/mercadopago/order-refund.ts")
  assert.match(refunds, /"begin_mercadopago_order_refund"/, "todo refund de MP reserva el intento antes de llamar a MP")
  const migration = read("supabase/migrations/20261014110000_refund_requires_invoice_first.sql")
  assert.match(migration, /before insert or update of status on public\.mercadopago_order_refunds/)
  assert.match(migration, /before insert on public\.order_refund_proofs/)
})
