import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

// La NC de reintegro externo se liquida cuando Mercado Pago confirma el
// reintegro (caso real: pedido #4, NC 1-5 autorizada y reintegro MP
// confirmado, pero la NC quedaba "pendiente" para siempre).

async function setup() {
  const db = new PGlite()
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create table order_credit_notes (
      id uuid primary key default gen_random_uuid(), order_id bigint not null, status text not null,
      destination text not null, total_amount numeric(12,2) not null, external_amount numeric(12,2),
      management_status text not null default 'reembolso_pendiente', settlement_status text not null default 'pendiente',
      settlement_date date, settlement_reference text, updated_at timestamptz default now(),
      constraint settlement_check check (settlement_status in ('pendiente','procesando','completado','rechazado'))
    );
    create table mercadopago_order_refunds (
      id uuid primary key default gen_random_uuid(), order_id bigint not null, payment_id text not null,
      amount numeric(12,2) not null, is_partial boolean not null default false, status text not null default 'processing',
      mp_refund_id text, completed_at timestamptz
    );
    create table order_audit_events (
      id bigserial primary key, order_id bigint not null, actor_type text not null, actor_id uuid, action text not null,
      previous_status text, new_status text, metadata jsonb, created_at timestamptz not null default now()
    );
  `)
  await db.exec(readFileSync("supabase/migrations/20261015120000_settle_credit_notes_after_mp_refund.sql", "utf8"))
  return db
}

const note = (db: PGlite, orderId: number, status: string, amount = 1000, destination = "external_refund") =>
  db.query<{ id: string }>("insert into order_credit_notes (order_id,status,destination,total_amount,external_amount) values ($1,$2,$3,$4,$4) returning id", [orderId, status, destination, amount])
    .then((result) => result.rows[0].id)
const refund = (db: PGlite, orderId: number, amount = 1000, status = "processing") =>
  db.query<{ id: string }>("insert into mercadopago_order_refunds (order_id,payment_id,amount,status) values ($1,'183036116203',$2,$3) returning id", [orderId, amount, status])
    .then((result) => result.rows[0].id)
const confirm = (db: PGlite, refundId: string, mpRefundId = "3443001068") =>
  db.query("update mercadopago_order_refunds set status='confirmed', mp_refund_id=$2, completed_at=now() where id=$1", [refundId, mpRefundId])
const noteState = (db: PGlite, id: string) =>
  db.query<{ settlement_status: string; management_status: string; total_amount: string; external_amount: string; settlement_reference: string | null }>(
    "select settlement_status, management_status, total_amount, external_amount, settlement_reference from order_credit_notes where id=$1", [id],
  ).then((result) => result.rows[0])
const settledEvents = (db: PGlite, orderId: number) =>
  db.query<{ count: number }>("select count(*)::int as count from order_audit_events where order_id=$1 and action='credit_note_settled_by_mp_refund'", [orderId])
    .then((result) => result.rows[0].count)

test("NC autorizada + reintegro MP confirmado → liquidada, sin tocar importes ni crear nada", async () => {
  const db = await setup()
  try {
    const noteId = await note(db, 4, "authorized")
    const refundId = await refund(db, 4)
    assert.equal((await noteState(db, noteId)).settlement_status, "pendiente", "en curso todavía no liquida")
    await confirm(db, refundId)
    const state = await noteState(db, noteId)
    assert.equal(state.settlement_status, "completado")
    assert.equal(state.management_status, "finalizada")
    assert.equal(state.settlement_reference, "mp_refund:3443001068")
    assert.equal(Number(state.total_amount), 1000)
    assert.equal(Number(state.external_amount), 1000)
    assert.equal(await settledEvents(db, 4), 1)
    assert.equal((await db.query<{ count: number }>("select count(*)::int as count from order_credit_notes")).rows[0].count, 1, "no se crea otra NC")
    assert.equal((await db.query<{ count: number }>("select count(*)::int as count from mercadopago_order_refunds")).rows[0].count, 1, "no se dispara otro reintegro")
  } finally { await db.close() }
})

test("webhook repetido / reconciliación repetida: idempotente, una sola constancia", async () => {
  const db = await setup()
  try {
    await note(db, 4, "authorized")
    const refundId = await refund(db, 4)
    await confirm(db, refundId)
    // El webhook vuelve a escribir el mismo estado y la reconciliación vuelve a correr.
    await confirm(db, refundId)
    await db.query("update mercadopago_order_refunds set completed_at=now() where id=$1", [refundId])
    assert.equal((await db.query<{ settled: number }>("select settle_credit_notes_after_mercadopago_refund(4) as settled")).rows[0].settled, 0)
    assert.equal(await settledEvents(db, 4), 1)
  } finally { await db.close() }
})

test("NC aún no autorizada: no se liquida; al autorizarse después, sí", async () => {
  const db = await setup()
  try {
    const noteId = await note(db, 7, "processing")
    await confirm(db, await refund(db, 7))
    assert.equal((await noteState(db, noteId)).settlement_status, "pendiente")
    await db.query("update order_credit_notes set status='authorized' where id=$1", [noteId])
    assert.equal((await noteState(db, noteId)).settlement_status, "completado")
    assert.equal(await settledEvents(db, 7), 1)
  } finally { await db.close() }
})

test("reintegro parcial: no liquida hasta cubrir la NC", async () => {
  const db = await setup()
  try {
    const noteId = await note(db, 8, "authorized", 1000)
    await confirm(db, await refund(db, 8, 400), "R-1")
    assert.equal((await noteState(db, noteId)).settlement_status, "pendiente", "faltan $600")
    await confirm(db, await refund(db, 8, 600), "R-2")
    const state = await noteState(db, noteId)
    assert.equal(state.settlement_status, "completado")
    assert.match(state.settlement_reference ?? "", /^mp_refund:R-1,R-2$/)
  } finally { await db.close() }
})

test("error de MP: un reintegro fallido nunca liquida la NC", async () => {
  const db = await setup()
  try {
    const noteId = await note(db, 9, "authorized")
    const refundId = await refund(db, 9)
    await db.query("update mercadopago_order_refunds set status='failed' where id=$1", [refundId])
    await db.query("update mercadopago_order_refunds set status='needs_reconciliation' where id=$1", [refundId])
    assert.equal((await noteState(db, noteId)).settlement_status, "pendiente")
    assert.equal(await settledEvents(db, 9), 0)
  } finally { await db.close() }
})

test("el mismo dinero no liquida dos NC; NC sólo fiscal o a saldo no se tocan", async () => {
  const db = await setup()
  try {
    const first = await note(db, 10, "authorized", 1000)
    await confirm(db, await refund(db, 10, 1000))
    assert.equal((await noteState(db, first)).settlement_status, "completado")
    // Una segunda NC posterior (p. ej. por transferencia) sigue pendiente.
    const second = await note(db, 10, "processing", 500)
    await db.query("update order_credit_notes set status='authorized' where id=$1", [second])
    assert.equal((await noteState(db, second)).settlement_status, "pendiente")

    const fiscalOnly = await note(db, 11, "authorized", 1000, "none")
    const balance = await note(db, 11, "authorized", 1000, "customer_balance")
    await confirm(db, await refund(db, 11, 1000))
    assert.equal((await noteState(db, fiscalOnly)).settlement_status, "pendiente")
    assert.equal((await noteState(db, balance)).settlement_status, "pendiente")
  } finally { await db.close() }
})

test("permisos: la función de liquidación sólo la ejecuta service_role", async () => {
  const db = await setup()
  try {
    const row = (await db.query(`select
      has_function_privilege('authenticated','settle_credit_notes_after_mercadopago_refund(bigint)','EXECUTE') as auth,
      has_function_privilege('service_role','settle_credit_notes_after_mercadopago_refund(bigint)','EXECUTE') as service`)).rows[0]
    assert.deepEqual(row, { auth: false, service: true })
  } finally { await db.close() }
})
