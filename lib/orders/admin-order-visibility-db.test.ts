import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

// Visibilidad de pedidos en Admin > Pedidos con el trigger y el constraint
// REALES (migraciones), en PostgreSQL embebido. Reproduce la secuencia del
// pedido BX-1002: pago confirmado → cancelación → reintegro → webhook de MP
// que persiste payment_status='refunded'.

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8")
const MIGRATIONS_BEFORE_FIX = [
  "supabase/migrations/20260815150000_enforce_admin_order_visibility_transition.sql",
  "supabase/migrations/20260903160000_admin_visibility_for_approved_payment_conflicts.sql",
  "supabase/migrations/20260906130000_fix_admin_visibility_check_for_payment_conflicts.sql",
  "supabase/migrations/20260922110000_admin_order_search.sql",
]
const FIX = "supabase/migrations/20261013230000_keep_reversed_mercadopago_orders_visible.sql"
const CONFIRMED_AT = "2026-10-13T22:30:30.000Z"

async function setup() {
  const db = new PGlite()
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create function auth.role() returns text language sql stable as $$
      select nullif(current_setting('request.jwt.claim.role', true), '') $$;
    create table public.ordenes (
      id bigint primary key, created_at timestamptz not null default now(), estado text,
      cliente_nombre text, cliente_email text, payment_method_id text, payment_id text,
      payment_status text, financial_status text, paid_at timestamptz, payment_confirmed_at timestamptz,
      admin_visible_at timestamptz, total numeric
    );
    create table public.productos (id bigint primary key, nombre text, sku text);
    create table public.producto_variantes (id bigint primary key, nombre text, sku text);
    create table public.orden_items (id bigint primary key, orden_id bigint, producto_id bigint, variante_id bigint);
  `)
  for (const migration of MIGRATIONS_BEFORE_FIX) await db.exec(read(migration))
  await db.query("select set_config('request.jwt.claim.role','service_role',false)")
  return db
}

/** Pedido MP pagado y confirmado (estado real tras el webhook de aprobación). */
async function insertConfirmedMercadoPagoOrder(db: PGlite, id: number) {
  await db.query(`insert into ordenes(id,estado,cliente_nombre,cliente_email,payment_method_id,payment_status,financial_status,total)
    values ($1,'pendiente','LUCAS ESPINOSA','cliente@example.test','mercadopago','preference_created','pending_payment',1000)`, [id])
  await db.query(`update ordenes set estado='pagado', payment_status='approved', financial_status='payment_confirmed',
    payment_id='9001'||$1::text, paid_at=$2, payment_confirmed_at=$2 where id=$1`, [id, CONFIRMED_AT])
}

/** Cancelación con reintegro completado y luego el webhook de MP del reintegro. */
async function cancelRefundAndNotify(db: PGlite, id: number, providerStatus = "refunded") {
  await db.query("update ordenes set estado='cancelado', financial_status='refund_pending' where id=$1", [id])
  await db.query("update ordenes set financial_status='refunded' where id=$1", [id])
  await db.query("update ordenes set payment_status=$2 where id=$1", [id, providerStatus])
}

const visibleAt = async (db: PGlite, id: number) =>
  (await db.query<{ admin_visible_at: Date | null }>("select admin_visible_at from ordenes where id=$1", [id])).rows[0].admin_visible_at
const adminList = async (db: PGlite) =>
  (await db.query<{ id: number }>("select id from ordenes where admin_visible_at is not null order by admin_visible_at desc, id desc")).rows.map((row) => Number(row.id))
const search = async (db: PGlite, term: string) =>
  (await db.query<{ result: { ids: number[]; total: number } }>("select search_admin_orders($1,50,0) result", [term])).rows[0].result

test("reproducción: con el trigger anterior, el webhook de reintegro ocultaba el pedido cancelado", async () => {
  const db = await setup()
  try {
    await insertConfirmedMercadoPagoOrder(db, 2)
    assert.equal((await visibleAt(db, 2))?.toISOString(), CONFIRMED_AT)
    await db.query("update ordenes set estado='cancelado', financial_status='refund_pending' where id=2")
    await db.query("update ordenes set financial_status='refunded' where id=2")
    assert.ok(await visibleAt(db, 2), "cancelado y reintegrado sigue visible mientras payment_status=approved")
    await db.query("update ordenes set payment_status='refunded' where id=2")
    assert.equal(await visibleAt(db, 2), null, "BUG: el webhook de MP lo sacaba de Admin")
    assert.deepEqual((await search(db, "BX-1002")).ids, [])
  } finally { await db.close() }
})

test("corrección: el pedido cancelado y reintegrado nunca desaparece (lista, BX, cliente) y el backfill lo recupera", async () => {
  const db = await setup()
  try {
    // Estado real previo a la corrección: oculto.
    await insertConfirmedMercadoPagoOrder(db, 2)
    await cancelRefundAndNotify(db, 2)
    assert.equal(await visibleAt(db, 2), null)

    await db.exec(read(FIX))
    assert.equal((await visibleAt(db, 2))?.toISOString(), CONFIRMED_AT, "backfill con la fecha original del pago")
    assert.deepEqual(await adminList(db), [2], "aparece en Todos los estados")
    assert.deepEqual((await search(db, "BX-1002")).ids, [2], "se busca por BX")
    assert.deepEqual((await search(db, "1002")).ids, [2])
    assert.deepEqual((await search(db, "lucas espinosa")).ids, [2], "se busca por cliente")
    const row = (await db.query<{ estado: string; total: string }>("select estado,total from ordenes where id=2")).rows[0]
    assert.deepEqual([row.estado, Number(row.total)], ["cancelado", 1000], "conserva estado e importe")

    // Con el trigger nuevo, la misma secuencia completa nunca lo oculta.
    await insertConfirmedMercadoPagoOrder(db, 4)
    await cancelRefundAndNotify(db, 4)
    assert.equal((await visibleAt(db, 4))?.toISOString(), CONFIRMED_AT)
    // Webhook repetido: idempotente.
    await db.query("update ordenes set payment_status='refunded' where id=4")
    assert.equal((await visibleAt(db, 4))?.toISOString(), CONFIRMED_AT)
  } finally { await db.close() }
})

test("contracargo y pago tardío sobre un pedido cancelado quedan visibles (hay dinero real)", async () => {
  const db = await setup()
  try {
    await db.exec(read(FIX))
    await insertConfirmedMercadoPagoOrder(db, 5)
    await cancelRefundAndNotify(db, 5, "charged_back")
    assert.ok(await visibleAt(db, 5), "charged_back")

    await db.query(`insert into ordenes(id,estado,payment_method_id,payment_status,financial_status)
      values (6,'cancelado','mercadopago','preference_created','cancelled')`)
    assert.equal(await visibleAt(db, 6), null)
    await db.query("update ordenes set payment_status='approved_after_cancellation', payment_id='777', paid_at=now() where id=6")
    assert.ok(await visibleAt(db, 6), "approved_after_cancellation")
  } finally { await db.close() }
})

test("regresión: intentos MP sin pago siguen fuera; transferencias y pedidos normales sin cambios", async () => {
  const db = await setup()
  try {
    await db.exec(read(FIX))
    // Intento técnico de MP nunca pagado (pendiente o cancelado por expiración).
    await db.query(`insert into ordenes(id,estado,payment_method_id,payment_status,financial_status)
      values (10,'pendiente','mercadopago','preference_created','pending_payment'),
             (11,'cancelado','mercadopago','checkout_superseded','cancelled')`)
    assert.equal(await visibleAt(db, 10), null)
    assert.equal(await visibleAt(db, 11), null)
    // "refunded" sin un pago confirmado previo no habilita visibilidad.
    await db.query("update ordenes set payment_status='refunded', payment_id='1' where id=10")
    assert.equal(await visibleAt(db, 10), null)
    // Transferencia: visible desde que se crea, también cancelada.
    await db.query(`insert into ordenes(id,estado,payment_method_id,payment_status,financial_status)
      values (12,'pendiente','transferencia','pendiente_comprobante','pending_payment')`)
    assert.ok(await visibleAt(db, 12))
    await db.query("update ordenes set estado='cancelado', financial_status='cancelled' where id=12")
    assert.ok(await visibleAt(db, 12))
    // Pedido MP pagado normal, enviado y entregado: visible con la misma fecha.
    await insertConfirmedMercadoPagoOrder(db, 13)
    await db.query("update ordenes set estado='entregado' where id=13")
    assert.equal((await visibleAt(db, 13))?.toISOString(), CONFIRMED_AT)
    // El constraint sigue rechazando visibilidad forzada de un intento sin pago.
    await db.exec("alter table ordenes disable trigger set_order_admin_visibility")
    await assert.rejects(
      db.query("update ordenes set admin_visible_at=now() where id=11"),
      /ordenes_admin_visibility_payment_check/,
    )
  } finally { await db.close() }
})
