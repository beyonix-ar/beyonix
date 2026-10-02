import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

import { computeBulkPriceUpdate } from "../pricing/bulk-price-engine.ts"

// Migración de eventos programados ejecutada de verdad (PGlite) sobre las
// tablas reales que toca (definiciones del baseline de producción): cada fase
// es una transacción idempotente, el snapshot restaura valores EXACTOS, un
// cambio manual posterior se respeta y la financiación vuelve a la política
// que había al empezar.

const MIGRATION = readFileSync(
  new URL("../../supabase/migrations/20261002100000_scheduled_commercial_events.sql", import.meta.url),
  "utf8",
)

const NOW = "2026-10-05T06:00:00.000Z"
const LATER = "2026-10-07T02:59:00.000Z"

async function setup() {
  const db = new PGlite()
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create table productos (
      id bigserial primary key, nombre text not null, slug text not null,
      precio numeric(10,2) not null, precio_anterior numeric(10,2), descuento integer default 0,
      categoria_id bigint, promo_event_id uuid
    );
    create table site_settings (
      key text primary key, value jsonb not null, description text default '' not null,
      updated_by uuid, updated_at timestamptz default now() not null
    );
    -- Definición del baseline de producción (2026-09-21).
    create table product_bulk_events (
      id uuid default gen_random_uuid() not null primary key,
      internal_name text not null, starts_on date, duration_days integer,
      scope text default 'product' not null, target_items jsonb default '[]' not null,
      action_kind text not null, value numeric, installments integer,
      status text default 'draft' not null, activated_at timestamptz,
      created_by uuid, updated_by uuid,
      created_at timestamptz default now() not null, updated_at timestamptz default now() not null,
      constraint product_bulk_events_action_kind_check check (action_kind = any (array['discount_percent','price_increase_percent','price_decrease_percent','installments','clear_offer'])),
      constraint product_bulk_events_status_check check (status = any (array['draft','active'])),
      constraint product_bulk_events_value_check check (value is null or (value >= 1 and value <= 99))
    );
    insert into productos (nombre, slug, precio, precio_anterior, descuento) values
      ('Auricular Ñandú', 'auricular', 50000, null, 0),
      ('Cámara Ñ', 'camara', 120000, 130000, 8),
      ('Trípode', 'tripode', 20000, null, null);
  `)
  await db.exec(MIGRATION)
  return db
}

type Product = { id: number; precio: string; precio_anterior: string | null; descuento: number | null; promo_event_id: string | null }

const products = async (db: PGlite) =>
  (await db.query<Product>("select id, precio, precio_anterior, descuento, promo_event_id from productos order by id")).rows

async function priceEvent(db: PGlite, { endsAt = LATER as string | null, kind = "price_decrease_percent", value = 10 } = {}) {
  const { rows } = await db.query<{ id: string }>(
    `insert into product_bulk_events (internal_name, event_type, status, starts_at, ends_at, scope, action_kind, value)
     values ('Promo', 'price_change', 'scheduled', $1, $2, 'store', $3, $4) returning id`,
    ["2026-10-05T05:00:00.000Z", endsAt, kind, value],
  )
  return rows[0].id
}

/** Lo que manda el runner: "antes" leído y "después" calculado con el núcleo del Editor masivo. */
async function updatesFor(db: PGlite, kind: "price_decrease_percent" | "price_increase_percent" = "price_decrease_percent", value = 10) {
  return (await products(db)).map((product) => ({
    product_id: product.id,
    before: { precio: Number(product.precio), precio_anterior: product.precio_anterior === null ? null : Number(product.precio_anterior), descuento: product.descuento },
    after: computeBulkPriceUpdate(product, kind, value),
  }))
}

const applyPrice = async (db: PGlite, id: string, updates: unknown, now = NOW) =>
  (await db.query<{ r: Record<string, unknown> }>("select apply_scheduled_price_event($1, $2::jsonb, $3) r", [id, JSON.stringify(updates), now])).rows[0].r
const restorePrice = async (db: PGlite, id: string, finalStatus = "finished") =>
  (await db.query<{ r: Record<string, unknown> }>("select restore_scheduled_price_event($1, $2, $3) r", [id, LATER, finalStatus])).rows[0].r
const eventRow = async (db: PGlite, id: string) =>
  (await db.query<Record<string, unknown>>("select * from product_bulk_events where id = $1", [id])).rows[0]

test("precios: aplica en una transacción, guarda snapshot exacto y toma los productos", async () => {
  const db = await setup()
  const id = await priceEvent(db)
  const before = await products(db)
  const result = await applyPrice(db, id, await updatesFor(db))
  assert.equal(result.status, "applied")
  assert.equal(result.affected, 3)

  const after = await products(db)
  assert.deepEqual(after.map((product) => Number(product.precio)), [45000, 108000, 18000])
  assert.ok(after.every((product) => product.promo_event_id === id), "evento temporal: productos tomados")

  const snapshot = (await db.query<{ product_id: string; precio_before: string; precio_anterior_before: string | null; descuento_before: number | null }>(
    "select product_id, precio_before, precio_anterior_before, descuento_before from product_price_event_snapshots where event_id = $1 order by product_id",
    [id],
  )).rows
  assert.deepEqual(
    snapshot.map((row) => [Number(row.precio_before), row.precio_anterior_before === null ? null : Number(row.precio_anterior_before), row.descuento_before]),
    before.map((product) => [Number(product.precio), product.precio_anterior === null ? null : Number(product.precio_anterior), product.descuento]),
  )
  const event = await eventRow(db, id)
  assert.equal(event.status, "active")
  assert.ok(event.executed_at)
})

test("precios: idempotente -- una segunda corrida no vuelve a aplicar", async () => {
  const db = await setup()
  const id = await priceEvent(db)
  const updates = await updatesFor(db)
  await applyPrice(db, id, updates)
  const once = await products(db)
  assert.deepEqual(await applyPrice(db, id, updates), { status: "skipped", eventStatus: "active" })
  assert.deepEqual(await products(db), once)
  assert.equal((await db.query("select 1 from product_price_event_snapshots where event_id = $1", [id])).rows.length, 3)
})

test("precios: reversión exacta a los valores anteriores (no recalcula +10%) y sólo una vez", async () => {
  const db = await setup()
  const before = await products(db)
  const id = await priceEvent(db)
  await applyPrice(db, id, await updatesFor(db))
  const restored = await restorePrice(db, id)
  assert.equal(restored.restored, 3)
  assert.deepEqual(await products(db), before.map((product) => ({ ...product, promo_event_id: null })))
  assert.equal((await eventRow(db, id)).status, "finished")
  assert.deepEqual(await restorePrice(db, id), { status: "skipped", eventStatus: "finished" }, "nunca revierte dos veces")
})

test("precios: un cambio manual durante el evento se respeta al restaurar", async () => {
  const db = await setup()
  const id = await priceEvent(db)
  await applyPrice(db, id, await updatesFor(db))
  await db.query("update productos set precio = 77700 where slug = 'camara'")
  const result = await restorePrice(db, id)
  assert.equal(result.restored, 2)
  assert.equal(result.keptManualChange, 1)
  const camara = (await products(db))[1]
  assert.equal(Number(camara.precio), 77700, "nunca se pisa con un snapshot que ya no corresponde")
  assert.equal(camara.promo_event_id, null, "el producto queda libre")
  const kept = (await db.query<{ restore_result: string }>("select restore_result from product_price_event_snapshots where event_id = $1 and product_id = 2", [id])).rows[0]
  assert.equal(kept.restore_result, "kept_manual_change")
})

test("precios: evento permanente se aplica una vez, queda finalizado y no toma productos", async () => {
  const db = await setup()
  const id = await priceEvent(db, { endsAt: null, kind: "price_increase_percent", value: 5 })
  await applyPrice(db, id, await updatesFor(db, "price_increase_percent", 5))
  assert.deepEqual((await products(db)).map((product) => Number(product.precio)), [52500, 126000, 21000])
  assert.ok((await products(db)).every((product) => product.promo_event_id === null))
  assert.equal((await eventRow(db, id)).status, "finished")
  assert.deepEqual(await restorePrice(db, id), { status: "skipped", eventStatus: "finished" }, "un permanente no se revierte")
})

test("precios: si los precios cambiaron entre el cálculo y la escritura no se modifica NADA", async () => {
  const db = await setup()
  const id = await priceEvent(db)
  const updates = await updatesFor(db)
  await db.query("update productos set precio = 21000 where slug = 'tripode'")
  const before = await products(db)
  await assert.rejects(applyPrice(db, id, updates), /PRICE_EVENT_STALE/)
  assert.deepEqual(await products(db), before, "ni siquiera los productos anteriores al cambiado")
  assert.equal((await eventRow(db, id)).status, "scheduled")
  assert.equal((await db.query("select 1 from product_price_event_snapshots")).rows.length, 0)
})

test("precios: un producto tomado por otro evento bloquea; un precio < 1 se rechaza", async () => {
  const db = await setup()
  const other = await priceEvent(db)
  await db.query("update productos set promo_event_id = $1 where slug = 'auricular'", [other])
  const id = await priceEvent(db)
  await assert.rejects(applyPrice(db, id, await updatesFor(db)), /PRODUCT_LOCKED_BY_EVENT/)
  await db.query("update productos set promo_event_id = null")
  const updates = await updatesFor(db)
  updates[0].after = { ...updates[0].after, precio: 0 }
  await assert.rejects(applyPrice(db, id, updates), /INVALID_PRICE/)
  await assert.rejects(applyPrice(db, id, await updatesFor(db), "2026-10-05T04:00:00.000Z"), /EVENT_NOT_DUE/)
})

test("precios: cancelar un evento activo restaura y queda Cancelado", async () => {
  const db = await setup()
  const before = await products(db)
  const id = await priceEvent(db)
  await applyPrice(db, id, await updatesFor(db))
  await restorePrice(db, id, "cancelled")
  const event = await eventRow(db, id)
  assert.equal(event.status, "cancelled")
  assert.ok(event.cancelled_at)
  assert.deepEqual(await products(db), before.map((product) => ({ ...product, promo_event_id: null })))
})

test("precios por monto: aplica y revierte snapshot exacto; baja inválida no deja escrituras", async () => {
  const db = await setup()
  const before = await products(db)
  const id = await priceEvent(db, { kind: "price_decrease_amount", value: 5_000 })
  const updates = before.map((product) => ({
    product_id: product.id,
    before: { precio: Number(product.precio), precio_anterior: product.precio_anterior === null ? null : Number(product.precio_anterior), descuento: product.descuento },
    after: computeBulkPriceUpdate(product, "price_decrease_amount", 5_000),
  }))
  await applyPrice(db, id, updates)
  assert.deepEqual((await products(db)).map((product) => Number(product.precio)), [45_000, 115_000, 15_000])
  await restorePrice(db, id)
  assert.deepEqual(await products(db), before)

  const invalid = await priceEvent(db, { kind: "price_decrease_amount", value: 50_000 })
  const invalidUpdates = before.map((product) => ({
    product_id: product.id,
    before: { precio: Number(product.precio), precio_anterior: product.precio_anterior === null ? null : Number(product.precio_anterior), descuento: product.descuento },
    after: computeBulkPriceUpdate(product, "price_decrease_amount", 50_000),
  }))
  await assert.rejects(applyPrice(db, invalid, invalidUpdates), /INVALID_PRICE/)
  assert.deepEqual(await products(db), before)
  assert.equal(Number((await db.query<{ count: string }>("select count(*) from product_price_event_snapshots where event_id = $1", [invalid])).rows[0].count), 0)
})

// ─── Financiación promocional ───

async function financingEvent(db: PGlite, startsAt = "2026-10-03T21:00:00.000Z", endsAt = "2026-10-06T02:59:00.000Z") {
  const { rows } = await db.query<{ id: string }>(
    `insert into product_bulk_events (internal_name, event_type, status, starts_at, ends_at, scope, financing_policy)
     values ('Promo financiación fin de semana', 'financing_policy', 'scheduled', $1, $2, 'store', 'same_as_cash') returning id`,
    [startsAt, endsAt],
  )
  return rows[0].id
}
const policy = async (db: PGlite) =>
  (await db.query<{ value: { policy: string; eventId?: string } }>("select value from site_settings where key = 'financed_price_policy'")).rows[0].value
const applyFinancing = async (db: PGlite, id: string) =>
  (await db.query<{ r: Record<string, unknown> }>("select apply_financing_policy_event($1, $2) r", [id, NOW])).rows[0].r
const restoreFinancing = async (db: PGlite, id: string) =>
  (await db.query<{ r: Record<string, unknown> }>("select restore_financing_policy_event($1, $2) r", [id, LATER])).rows[0].r

test("financiación: la migración deja 'cubrir costos' como política existente", async () => {
  const db = await setup()
  assert.deepEqual(await policy(db), { policy: "cover_costs" })
})

for (const previous of ["cover_costs", "same_as_cash"] as const) {
  test(`financiación: guarda la política anterior (${previous}), aplica 'mismo precio' y al terminar vuelve exactamente a ella`, async () => {
    const db = await setup()
    await db.query("update site_settings set value = $1 where key = 'financed_price_policy'", [JSON.stringify({ policy: previous })])
    const id = await financingEvent(db)
    const applied = await applyFinancing(db, id)
    assert.equal(applied.previousPolicy, previous)
    assert.deepEqual(await policy(db), { policy: "same_as_cash", eventId: id })
    assert.equal((await eventRow(db, id)).previous_financing_policy, previous)
    assert.equal((await eventRow(db, id)).status, "active")

    const restored = await restoreFinancing(db, id)
    assert.equal(restored.restoredPolicy, previous)
    assert.deepEqual(await policy(db), { policy: previous })
    assert.equal((await eventRow(db, id)).status, "finished")
  })
}

test("financiación: idempotente al activar y al restaurar", async () => {
  const db = await setup()
  const id = await financingEvent(db)
  await applyFinancing(db, id)
  assert.deepEqual(await applyFinancing(db, id), { status: "skipped", eventStatus: "active" })
  assert.equal((await eventRow(db, id)).previous_financing_policy, "cover_costs", "una segunda corrida no pisa el snapshot")
  await restoreFinancing(db, id)
  assert.deepEqual(await restoreFinancing(db, id), { status: "skipped", eventStatus: "finished" })
})

test("financiación: nunca dos eventos activos a la vez", async () => {
  const db = await setup()
  const first = await financingEvent(db)
  const second = await financingEvent(db, "2026-10-04T13:00:00.000Z", "2026-10-07T13:00:00.000Z")
  await applyFinancing(db, first)
  await assert.rejects(applyFinancing(db, second), /FINANCING_EVENT_ACTIVE/)
  assert.deepEqual(await policy(db), { policy: "same_as_cash", eventId: first })
})

test("financiación: un cambio manual se bloquea mientras el evento controla la política", async () => {
  const db = await setup()
  await db.query("select set_financed_price_policy('same_as_cash', null, $1)", [NOW])
  assert.deepEqual(await policy(db), { policy: "same_as_cash" })
  const id = await financingEvent(db)
  await applyFinancing(db, id)
  await assert.rejects(db.query("select set_financed_price_policy('cover_costs', null, $1)", [NOW]), /FINANCING_POLICY_CONTROLLED_BY_EVENT/)
  assert.deepEqual(await policy(db), { policy: "same_as_cash", eventId: id })
  await restoreFinancing(db, id)
  assert.deepEqual(await policy(db), { policy: "same_as_cash" })
})

test("financiación: una política sobrescrita externamente no se restaura en silencio", async () => {
  const db = await setup()
  const id = await financingEvent(db)
  await applyFinancing(db, id)
  await db.query("update site_settings set value = '{\"policy\":\"cover_costs\"}' where key = 'financed_price_policy'")
  await assert.rejects(restoreFinancing(db, id), /FINANCING_POLICY_STALE/)
  assert.deepEqual(await policy(db), { policy: "cover_costs" })
  assert.equal((await eventRow(db, id)).status, "active")
})

test("restricciones: financiación sin fin, fin anterior al inicio, estados y tipos inválidos se rechazan", async () => {
  const db = await setup()
  await assert.rejects(
    db.query(`insert into product_bulk_events (internal_name, event_type, status, starts_at, scope, financing_policy) values ('x','financing_policy','scheduled',now(),'store','same_as_cash')`),
    /financing_shape/,
  )
  await assert.rejects(
    db.query(`insert into product_bulk_events (internal_name, event_type, status, starts_at, ends_at, scope, action_kind, value) values ('x','price_change','scheduled','2026-10-05','2026-10-04','store','price_increase_percent',5)`),
    /schedule_check/,
  )
  await assert.rejects(
    db.query(`insert into product_bulk_events (internal_name, status, scope, action_kind, value) values ('x','pausado','store','price_increase_percent',5)`),
    /status_check/,
  )
  await assert.rejects(
    db.query(`insert into product_bulk_events (internal_name, event_type, status, starts_at, scope, action_kind, value) values ('x','price_change','scheduled',now(),'store','price_increase_percent',150)`),
    /value_check/,
  )
  // Los eventos manuales previos siguen siendo válidos.
  await db.query(`insert into product_bulk_events (internal_name, status, scope, action_kind, value, starts_on) values ('Hot Sale', 'draft', 'store', 'discount_percent', 10, '2026-10-10')`)
})

test("seguridad: las funciones y el snapshot sólo son del servidor (service_role)", async () => {
  const db = await setup()
  for (const fn of [
    "apply_scheduled_price_event(uuid, jsonb, timestamptz)",
    "restore_scheduled_price_event(uuid, timestamptz, text)",
    "apply_financing_policy_event(uuid, timestamptz)",
    "restore_financing_policy_event(uuid, timestamptz, text)",
    "set_financed_price_policy(text, uuid, timestamptz)",
  ]) {
    for (const role of ["anon", "authenticated"]) {
      const { rows } = await db.query<{ allowed: boolean }>(`select has_function_privilege('${role}', 'public.${fn}', 'execute') allowed`)
      assert.equal(rows[0].allowed, false, `${role} ${fn}`)
    }
    const { rows } = await db.query<{ allowed: boolean }>(`select has_function_privilege('service_role', 'public.${fn}', 'execute') allowed`)
    assert.equal(rows[0].allowed, true, fn)
  }
  const { rows } = await db.query<{ allowed: boolean }>("select has_table_privilege('authenticated', 'public.product_price_event_snapshots', 'select') allowed")
  assert.equal(rows[0].allowed, false)
  for (const role of ["anon", "authenticated"]) {
    const eventRights = await db.query<{ allowed: boolean }>(`select has_table_privilege('${role}', 'public.product_bulk_events', 'insert, update, delete') allowed`)
    assert.equal(eventRights.rows[0].allowed, false)
  }
})
