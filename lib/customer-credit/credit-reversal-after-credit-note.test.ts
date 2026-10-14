import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

// Saldo a favor usado como medio de pago: pago confirmado → Factura C → NC C
// → recién ahí vuelve el saldo (20261014120000). Funciones SQL REALES de saldo
// (get_customer_credit_balance, apply_customer_credit_to_order) y la versión
// nueva de reverse_customer_credit_for_order + el trigger de la NC, en
// PostgreSQL embebido. Sin ARCA, Mercado Pago ni datos reales.

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8").replace(/\r\n/g, "\n")
const baseline = read("supabase/migrations/20260911130000_harden_customer_credit_rpc_authorization.sql")
const fn = (name: string) => baseline.match(
  new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?AS \\$function\\$[\\s\\S]*?\\$function\\$;`),
)![0]
const migration = read("supabase/migrations/20261014130000_credit_note_fiscal_vs_money_split.sql")
const migrationFunction = (name: string) => {
  const start = migration.indexOf(`create or replace function public.${name}(`)
  return migration.slice(start, migration.indexOf("$$;", migration.indexOf("as $$", start)) + 3)
}

const user = "20000000-0000-4000-8000-000000000001"
const admin = "20000000-0000-4000-8000-000000000002"

type Fiscal = "unpaid" | "queued" | "invoiced"

async function setup() {
  const db = new PGlite()
  await db.exec(read("lib/customer-credit/fixtures/credit-reversal-order-due.sql"))
  await db.exec(`
    alter table public.ordenes add column invoice_queued_at timestamptz, add column invoice_cae text;
    create table public.order_credit_notes (id uuid primary key default gen_random_uuid(), order_id bigint, status text, created_by uuid,
      customer_credit_amount numeric(12,2) not null default 0);
    create table public.order_audit_events (id bigint generated always as identity primary key, order_id bigint,
      actor_type text, actor_id uuid, action text, previous_status text, new_status text, metadata jsonb,
      created_at timestamptz default now());
    grant all privileges on public.order_credit_notes, public.order_audit_events to service_role;
  `)
  await db.exec(fn("get_customer_credit_balance"))
  await db.exec(fn("apply_customer_credit_to_order"))
  await db.exec(read("supabase/migrations/20261014120000_customer_credit_reversal_after_credit_note.sql"))
  await db.exec(migrationFunction("order_customer_credit_reversal_on_hold"))
  await db.exec(migrationFunction("restore_customer_credit_after_credit_note"))
  await db.query("insert into auth.users (id) values ($1)", [user])
  await db.query(`insert into public.customer_credit_movements (user_id, movement_type, amount, description, source_type, resulting_balance)
    values ($1, 'credit', 30000, 'Carga inicial', 'admin_adjustment', 30000)`, [user])
  await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ role: "service_role" })])
  await db.exec("set role service_role")
  return db
}

/** Pedido de $100.000 con $30.000 de saldo aplicado (estado fiscal según el caso). */
async function orderWithCredit(db: PGlite, id: number, fiscal: Fiscal) {
  await db.query(`insert into public.ordenes (id, usuario_id, total, original_total, external_amount_due, estado, financial_status,
      invoice_queued_at, invoice_cae) values ($1,$2,100000,100000,100000,'pagado','payment_confirmed',$3,$4)`,
    [id, user, fiscal === "unpaid" ? null : new Date().toISOString(), fiscal === "invoiced" ? "CAE-1" : null])
  await db.query("select * from public.apply_customer_credit_to_order($1, $2, 30000)", [user, id])
  if (fiscal === "unpaid") await db.query("update public.ordenes set estado='pendiente', financial_status='pending_payment' where id=$1", [id])
}

/** Lo que hacen admin_cancel_order / cancelación del cliente: cancelar y pedir la reversión. */
async function cancel(db: PGlite, id: number) {
  await db.query("update public.ordenes set estado='cancelado', financial_status='refund_pending' where id=$1", [id])
  return (await db.query<{ restored_amount: string }>(
    "select * from public.reverse_customer_credit_for_order($1, 'Reintegro de saldo a favor por cancelación de pedido', $2)", [id, admin],
  )).rows[0]
}

const balance = async (db: PGlite) =>
  Number((await db.query<{ b: string }>("select public.get_customer_credit_balance($1) b", [user])).rows[0].b)
const reversals = async (db: PGlite, id: number) =>
  Number((await db.query<{ n: number }>("select count(*)::int n from public.customer_credit_movements where order_id=$1 and movement_type='reversal'", [id])).rows[0].n)
const creditUsed = async (db: PGlite, id: number) =>
  Number((await db.query<{ c: string }>("select credit_balance_used c from public.ordenes where id=$1", [id])).rows[0].c)
const setNote = (db: PGlite, id: number, status: string, creditAmount = 0) =>
  db.query("insert into public.order_credit_notes (order_id, status, created_by, customer_credit_amount) values ($1,$2,$3,$4)", [id, status, admin, creditAmount])

test("1. saldo aplicado + sin Factura C: cancelar NO devuelve el saldo y la obligación sigue", async () => {
  const db = await setup()
  try {
    await orderWithCredit(db, 1, "queued")
    assert.equal(await balance(db), 0)
    assert.equal(Number((await cancel(db, 1)).restored_amount), 0)
    assert.equal(await balance(db), 0, "el saldo no vuelve antes de la factura")
    assert.equal(await creditUsed(db, 1), 30000, "el pedido conserva el saldo aplicado")
    assert.equal(await reversals(db, 1), 0)
    const deferred = await db.query("select 1 from public.order_audit_events where order_id=1 and action='customer_credit_reversal_deferred'")
    assert.equal(deferred.rows.length, 1, "queda auditado")
  } finally { await db.close() }
})

test("2/6. Factura C sin NC (o NC con error de ARCA / en proceso): el saldo no vuelve", async () => {
  const db = await setup()
  try {
    await orderWithCredit(db, 1, "invoiced")
    await cancel(db, 1)
    await setNote(db, 1, "processing", 30000)
    await db.query("update public.order_credit_notes set status='error' where order_id=1")
    assert.equal(await balance(db), 0)
    assert.equal(await reversals(db, 1), 0)
    // Error de ARCA en la factura (sigue encolada, sin CAE): tampoco.
    await db.query(`insert into public.customer_credit_movements (user_id, movement_type, amount, description, source_type, resulting_balance)
      values ($1, 'credit', 30000, 'Carga', 'admin_adjustment', 30000)`, [user])
    await orderWithCredit(db, 2, "queued")
    await cancel(db, 2)
    assert.equal(await reversals(db, 2), 0)
  } finally { await db.close() }
})

test("3. Factura C + NC C autorizada: el saldo vuelve exactamente una vez, por el total aplicado", async () => {
  const db = await setup()
  try {
    await orderWithCredit(db, 1, "invoiced")
    await cancel(db, 1)
    await setNote(db, 1, "processing", 30000)
    await db.query("update public.order_credit_notes set status='authorized' where order_id=1")
    assert.equal(await balance(db), 30000)
    assert.equal(await reversals(db, 1), 1)
    assert.equal(await creditUsed(db, 1), 0)
  } finally { await db.close() }
})

test("5/7. reintentos, doble click y NC repetidas: nunca se duplica el saldo", async () => {
  const db = await setup()
  try {
    await orderWithCredit(db, 1, "invoiced")
    await cancel(db, 1)
    await cancel(db, 1)
    assert.equal(await reversals(db, 1), 0)
    await setNote(db, 1, "authorized", 30000)
    // Doble click de cancelar después de la NC, otra NC autorizada y re-update.
    await cancel(db, 1)
    await cancel(db, 1)
    await setNote(db, 1, "authorized")
    await db.query("update public.order_credit_notes set status='authorized' where order_id=1")
    assert.equal(await reversals(db, 1), 1)
    assert.equal(await balance(db), 30000)
  } finally { await db.close() }
})

test("4. sin saldo aplicado o sin pago confirmado: no cambia nada respecto de hoy", async () => {
  const db = await setup()
  try {
    // Sin saldo: nada que restaurar.
    await db.query(`insert into public.ordenes (id, usuario_id, total, original_total, external_amount_due, estado, invoice_queued_at)
      values (5, $1, 1000, 1000, 1000, 'pagado', now())`, [user])
    assert.equal(Number((await cancel(db, 5)).restored_amount), 0)
    await setNote(db, 5, "authorized")
    assert.equal(await reversals(db, 5), 0)
    // Pago nunca confirmado (MP rechazado, checkout vencido): restaura en el acto.
    await orderWithCredit(db, 6, "unpaid")
    assert.equal(Number((await cancel(db, 6)).restored_amount), 30000)
    assert.equal(await reversals(db, 6), 1)
  } finally { await db.close() }
})

test("NC parcial sobre un pedido vigente restituye sólo su parte del saldo", async () => {
  const db = await setup()
  try {
    await orderWithCredit(db, 1, "invoiced")
    await setNote(db, 1, "authorized", 10000)
    assert.equal(await reversals(db, 1), 1)
    assert.equal(await balance(db), 10000)
    assert.equal(await creditUsed(db, 1), 20000)
  } finally { await db.close() }
})
