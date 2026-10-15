import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

// 20261015170000: incidentes únicos, conciliación de 'processing' colgados y
// liquidación NC ↔ reintegro MP por orden. Funciones reales de la migración.

const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n")

async function setup() {
  const db = new PGlite()
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create function auth.role() returns text language sql as $$ select current_setting('request.jwt.claim.role', true) $$;
    create table ordenes (id bigint primary key, financial_status text);
    create table order_credit_notes (
      id uuid primary key default gen_random_uuid(), order_id bigint not null, status text not null,
      destination text not null, total_amount numeric(12,2) not null, external_amount numeric(12,2),
      management_status text not null default 'reembolso_pendiente', settlement_status text not null default 'pendiente',
      settlement_date date, settlement_reference text, authorized_at timestamptz, created_at timestamptz default now(),
      updated_at timestamptz default now()
    );
    create table mercadopago_order_refunds (
      id uuid primary key default gen_random_uuid(), order_id bigint not null, payment_id text not null default '1',
      amount numeric(12,2) not null, is_partial boolean not null default false, status text not null default 'processing',
      mp_refund_id text, completed_at timestamptz, reconciliation_locked_at timestamptz, updated_at timestamptz not null default now()
    );
    create table order_audit_events (
      id bigserial primary key, order_id bigint not null, actor_type text not null, actor_id uuid, action text not null,
      previous_status text, new_status text, metadata jsonb, created_at timestamptz not null default now()
    );
  `)
  await db.exec(read("supabase/migrations/20261015120000_settle_credit_notes_after_mp_refund.sql"))
  await db.exec(read("supabase/migrations/20261015170000_mercadopago_refund_closure.sql"))
  await db.query("select set_config('request.jwt.claim.role','service_role',false)")
  await db.exec("insert into ordenes values (4,'refunded'),(8,'refund_pending')")
  return db
}

const incident = (db: PGlite, key: string, amount = 10000) =>
  db.query<{ recorded: boolean }>("select record_mercadopago_payment_incident(4,'mp_external_refund_detected',$1,$2::jsonb) as recorded",
    [key, JSON.stringify({ paymentId: "183036116203", amount })]).then((result) => result.rows[0].recorded)

test("incidente externo: una sola alerta por refund aunque el webhook se repita; eventos viejos intactos", async () => {
  const db = await setup()
  try {
    // Evento heredado sin clave (#25): no choca con nada.
    await db.exec("insert into order_audit_events(order_id,actor_type,action,metadata) values (4,'system','mp_external_refund_detected','{}')")
    assert.equal(await incident(db, "mp_refund:777"), true)
    assert.equal(await incident(db, "mp_refund:777"), false, "webhook repetido")
    assert.equal(await incident(db, "mp_refund:778", 500), true, "otro refund externo sí alerta")
    const rows = (await db.query<{ n: number; with_key: number }>(`select count(*)::int n,
      count(*) filter (where metadata ? 'incidentKey')::int with_key from order_audit_events where action='mp_external_refund_detected'`)).rows[0]
    assert.deepEqual(rows, { n: 3, with_key: 2 })
    await assert.rejects(db.query("select record_mercadopago_payment_incident(4,'order_refunded','x','{}')"), /NOT_A_PAYMENT_INCIDENT/)
    await db.query("select set_config('request.jwt.claim.role','authenticated',false)")
    await assert.rejects(incident(db, "mp_refund:999"), /FORBIDDEN/)
  } finally { await db.close() }
})

test("conciliación por lote: toma needs_reconciliation y 'processing' colgados, nunca un POST en vuelo", async () => {
  const db = await setup()
  try {
    await db.exec(`insert into mercadopago_order_refunds(order_id,amount,status,updated_at) values
      (1,100,'processing',now()),
      (2,100,'processing',now() - interval '11 minutes'),
      (3,100,'needs_reconciliation',now()),
      (5,100,'confirmed',now() - interval '1 day')`)
    const claimed = (await db.query<{ order_id: number }>("select order_id from claim_mercadopago_refunds_for_reconciliation(10,300) order by order_id")).rows
    assert.deepEqual(claimed.map((row) => Number(row.order_id)), [2, 3])
    // Dos workers a la vez: el lock evita tomarlo de nuevo dentro del timeout.
    assert.equal((await db.query("select * from claim_mercadopago_refunds_for_reconciliation(10,300)")).rows.length, 0)
  } finally { await db.close() }
})

async function note(db: PGlite, orderId: number, amount: number, minutesAgo: number, status = "authorized") {
  return (await db.query<{ id: string }>(`insert into order_credit_notes(order_id,status,destination,total_amount,external_amount,authorized_at)
    values ($1,$2,'external_refund',$3,$3,now() - make_interval(mins => $4)) returning id`, [orderId, status, amount, minutesAgo])).rows[0].id
}
const state = (db: PGlite, id: string) =>
  db.query<{ settlement_status: string }>("select settlement_status from order_credit_notes where id=$1", [id]).then((result) => result.rows[0].settlement_status)
const confirmRefund = (db: PGlite, orderId: number, amount: number, mpId: string) =>
  db.query("insert into mercadopago_order_refunds(order_id,amount,status,mp_refund_id,completed_at) values ($1,$2,'confirmed',$3,now())", [orderId, amount, mpId])

test("liquidación por orden: el refund cubre la primera NC y no la segunda → sólo la primera", async () => {
  const db = await setup()
  try {
    const first = await note(db, 8, 400, 10)
    const second = await note(db, 8, 600, 5)
    await confirmRefund(db, 8, 500, "R-1")
    assert.equal(await state(db, first), "completado")
    assert.equal(await state(db, second), "pendiente", "$100 sobrantes no liquidan una NC de $600")
    await confirmRefund(db, 8, 500, "R-2")
    assert.equal(await state(db, second), "completado")
    const settled = (await db.query<{ n: number }>("select count(*)::int n from order_audit_events where action='credit_note_settled_by_mp_refund'")).rows[0].n
    assert.equal(settled, 2, "cada NC una sola vez")
    assert.equal((await db.query<{ n: number }>("select settle_credit_notes_after_mercadopago_refund(8) n")).rows[0].n, 0, "idempotente")
  } finally { await db.close() }
})

test("el mismo dinero nunca liquida dos NC y una NC nunca con dinero insuficiente", async () => {
  const db = await setup()
  try {
    await confirmRefund(db, 8, 1000, "R-1")
    const first = await note(db, 8, 1000, 10, "processing")
    await db.query("update order_credit_notes set status='authorized' where id=$1", [first])
    assert.equal(await state(db, first), "completado")
    const second = await note(db, 8, 1000, 1, "processing")
    await db.query("update order_credit_notes set status='authorized' where id=$1", [second])
    assert.equal(await state(db, second), "pendiente")
  } finally { await db.close() }
})
