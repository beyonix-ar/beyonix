import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8")
const actor = "20000000-0000-4000-8000-000000000002"
let requestNumber = 0
const key = () => `40000000-0000-4000-8000-${String(++requestNumber).padStart(12, "0")}`
const parcel = (weightKg: number, lengthCm: number, widthCm: number, heightCm: number) =>
  ({ weightKg, lengthCm, widthCm, heightCm })

async function setup() {
  const db = new PGlite()
  await db.exec(read("lib/orders/fixtures/dispatch-schema.sql"))
  await db.exec(read("supabase/migrations/20260820120000_cost_catalog_barcode.sql"))
  await db.exec(read("supabase/migrations/20261005100000_dispatch_operations.sql"))
  await db.exec(read("supabase/migrations/20261005110000_dispatch_guards.sql"))
  await db.exec(read("supabase/migrations/20261007100000_barcodes_parcels_dispatch.sql"))
  // Columnas reales de `ordenes` que el fixture de despacho no necesitaba.
  await db.exec(`alter table ordenes
    add column created_at timestamptz not null default now(),
    add column shipping_cost_real numeric,
    add column shipping_cost_charged numeric,
    add column delivered_at timestamptz`)
  await db.exec(read("supabase/migrations/20261008100000_shipping_quote_snapshot_parcel_measures.sql"))
  await db.query("select set_config('request.jwt.claim.role','service_role',false)")
  await db.query("insert into profiles(id,rol) values ($1,'operador')", [actor])
  await db.exec("insert into productos(id,sku,codigo_barra,nombre) values (1,'SKU-A','BAR-A','Auriculares Pro')")
  await db.exec("insert into producto_variantes values (11,1,'SKU-A-RED','BAR-A-RED')")
  await db.exec("insert into catalog_sku_registry values ('SKU-A',1,null),('SKU-A-RED',null,11)")
  await db.exec("insert into ordenes(id) values (1031)")
  await db.exec("insert into orden_items(id,orden_id,producto_id,variante_id,cantidad) values (1,1031,1,11,2)")
  return db
}

async function packOrder(db: PGlite) {
  await db.query("select begin_order_preparation($1,$2)", [1031, actor])
  await db.query("select scan_order_preparation_item($1,$2,$3,$4,$5)", [1031, 1, "BAR-A-RED", actor, key()])
  await db.query("select scan_order_preparation_item($1,$2,$3,$4,$5)", [1031, 1, "BAR-A-RED", actor, key()])
}

const setParcels = (db: PGlite, parcels: unknown, requestKey = key()) =>
  db.query("select (set_order_package_parcels_measured($1,$2::jsonb,$3,$4)).parcel_count", [1031, JSON.stringify(parcels), actor, requestKey])

async function currentParcels(db: PGlite) {
  return (await db.query<{ barcode: string; actual_weight_kg: string; actual_length_cm: string; actual_width_cm: string; actual_height_cm: string; actual_volume_cm3: string }>(
    `select p.barcode, p.actual_weight_kg, p.actual_length_cm, p.actual_width_cm, p.actual_height_cm, p.actual_volume_cm3
     from order_package_parcels p join order_packages k on k.id=p.package_id and k.attempt_number=p.attempt_number
     where p.order_id=1031 order by p.parcel_index`)).rows
}

test("armado: 1 bulto real con peso y medidas, volumen calculado por la base", async () => {
  const db = await setup()
  try {
    await packOrder(db)
    await setParcels(db, [parcel(2.45, 40, 30, 20)])
    const [row] = await currentParcels(db)
    assert.equal(row.barcode, "BX-PKG-2031-01")
    assert.deepEqual([Number(row.actual_weight_kg), Number(row.actual_length_cm), Number(row.actual_width_cm), Number(row.actual_height_cm)], [2.45, 40, 30, 20])
    assert.equal(Number(row.actual_volume_cm3), 24_000)
    const audit = (await db.query<{ metadata: { parcels: unknown[] } }>("select metadata from order_audit_events where order_id=1031 and action='order_parcels_defined'")).rows[0]
    assert.equal(audit.metadata.parcels.length, 1)
  } finally { await db.close() }
})

test("armado: 2+ bultos, cada uno con sus medidas; misma cantidad conserva etiquetas", async () => {
  const db = await setup()
  try {
    await packOrder(db)
    await setParcels(db, [parcel(1.2, 30, 20, 10), parcel(0.8, 25, 20, 8)])
    assert.deepEqual((await currentParcels(db)).map((row) => row.barcode), ["BX-PKG-2031-01", "BX-PKG-2031-02"])
    const before = (await db.query<{ id: number }>("select id from order_package_parcels order by id")).rows.map((row) => row.id)
    await setParcels(db, [parcel(1.25, 31, 20, 10), parcel(0.8, 25, 20, 8)])
    const after = (await db.query<{ id: number }>("select id from order_package_parcels order by id")).rows.map((row) => row.id)
    assert.deepEqual(after, before, "corregir medidas no regenera etiquetas")
    assert.equal(Number((await currentParcels(db))[0].actual_weight_kg), 1.25)
    await setParcels(db, [parcel(2, 40, 30, 20)])
    assert.deepEqual((await currentParcels(db)).map((row) => row.barcode), ["BX-PKG-2031-01"])
  } finally { await db.close() }
})

test("medidas obligatorias y válidas: se rechazan faltantes, cero, negativos, texto y absurdos", async () => {
  const db = await setup()
  try {
    await packOrder(db)
    const invalid: unknown[] = [
      [],
      [{ weightKg: 1, lengthCm: 10, widthCm: 10 }],
      [parcel(0, 10, 10, 10)],
      [parcel(1, -10, 10, 10)],
      [{ weightKg: "1", lengthCm: 10, widthCm: 10, heightCm: 10 }],
      [parcel(1001, 10, 10, 10)],
      [parcel(1, 501, 10, 10)],
      Array.from({ length: 51 }, () => parcel(1, 10, 10, 10)),
    ]
    for (const parcels of invalid) {
      await assert.rejects(setParcels(db, parcels), /DISPATCH_PARCEL_(MEASURES_INVALID|COUNT_INVALID)/)
    }
    await assert.rejects(db.exec("insert into order_package_parcels(package_id,order_id,attempt_number,parcel_index,parcel_count,barcode,created_by,actual_weight_kg) select id,order_id,attempt_number,1,1,'BX-PKG-2031-01',$$" + actor + "$$,1 from order_packages"), /measures_complete/)
  } finally { await db.close() }
})

test("idempotente por request key y rearmado: las etiquetas viejas dejan de valer", async () => {
  const db = await setup()
  try {
    await packOrder(db)
    const requestKey = key()
    await setParcels(db, [parcel(1, 20, 20, 20)], requestKey)
    await setParcels(db, [parcel(9, 99, 99, 99)], requestKey)
    assert.equal(Number((await currentParcels(db))[0].actual_weight_kg), 1, "un reintento no aplica otro payload")
    await db.query("select reset_order_preparation($1,$2,$3,$4)", [1031, actor, key(), "Rearmar con caja más grande"])
    await db.query("select scan_order_preparation_item($1,$2,$3,$4,$5)", [1031, 1, "BAR-A-RED", actor, key()])
    await db.query("select scan_order_preparation_item($1,$2,$3,$4,$5)", [1031, 1, "BAR-A-RED", actor, key()])
    await setParcels(db, [parcel(1.4, 30, 25, 20)])
    assert.deepEqual((await currentParcels(db)).map((row) => row.barcode), ["BX-PKG-2031-R2-01"])
    const lot = (await db.query<{ id: number }>("select (create_dispatch_batch($1,$2)).id", [actor, key()])).rows[0]
    await assert.rejects(db.query("select scan_dispatch_parcel($1,$2,$3,$4)", [lot.id, "BX-PKG-2031-01", actor, key()]), /DISPATCH_PARCEL_STALE/)
  } finally { await db.close() }
})

test("recotización con bultos reales: sólo se guarda para la definición vigente", async () => {
  const db = await setup()
  try {
    await packOrder(db)
    const oldKey = key()
    await setParcels(db, [parcel(1, 20, 20, 20)], oldKey)
    const newKey = key()
    await setParcels(db, [parcel(1.5, 30, 20, 20)], newKey)
    const record = (requestKey: string, status: string, amount: number | null) =>
      db.query<{ ok: boolean }>("select record_order_parcel_quote($1,$2,$3,$4,$5::jsonb,$6) ok", [1031, requestKey, status, amount, "[]", null])
    assert.equal((await record(oldKey, "quoted", 9_000)).rows[0].ok, false)
    assert.equal((await record(newKey, "quoted", 10_380)).rows[0].ok, true)
    const order = (await db.query<{ shipping_parcel_quote_amount: string; shipping_parcel_quote_status: string }>("select shipping_parcel_quote_amount, shipping_parcel_quote_status from ordenes where id=1031")).rows[0]
    assert.deepEqual([Number(order.shipping_parcel_quote_amount), order.shipping_parcel_quote_status], [10_380, "quoted"])
    await assert.rejects(record(newKey, "quoted", null), /PARCEL_QUOTE_INVALID/)
    await assert.rejects(record(newKey, "failed", 100), /PARCEL_QUOTE_INVALID/)
    await db.query("select set_config('request.jwt.claim.role','authenticated',false)")
    await assert.rejects(record(newKey, "quoted", 1), /DISPATCH_FORBIDDEN/)
    await assert.rejects(setParcels(db, [parcel(1, 20, 20, 20)]), /DISPATCH_FORBIDDEN/)
  } finally { await db.close() }
})

test("snapshot: la identidad tarifa + recargo + ajuste = precio logístico se exige en la base", async () => {
  const db = await setup()
  try {
    await db.exec(`update ordenes set shipping_cost_real=11000, shipping_cost_charged=8000,
      shipping_provider_quote_amount=10000, shipping_markup_percent=5, shipping_markup_amount=500,
      shipping_rounding_amount=500, shipping_benefit_amount=3000 where id=1031`)
    await assert.rejects(db.exec("update ordenes set shipping_markup_amount=900 where id=1031"), /snapshot_identity/)
    await assert.rejects(db.exec("update ordenes set shipping_markup_percent=null where id=1031"), /snapshot_complete/)
    await assert.rejects(db.exec("update ordenes set shipping_markup_percent=51, shipping_markup_amount=500 where id=1031"), /markup_percent/)
    await assert.rejects(db.exec("update ordenes set andreani_billed_amount=9800 where id=1031"), /andreani_billed_amount/)
  } finally { await db.close() }
})

test("Dashboard: costo extra cobrado = suma histórica persistida (3% + 3% + 5%), no el % actual", async () => {
  const db = await setup()
  try {
    await db.exec("delete from orden_items; delete from ordenes")
    await db.exec(`insert into ordenes(id, estado, shipping_cost_real, shipping_cost_charged, shipping_provider_quote_amount,
        shipping_markup_percent, shipping_markup_amount, shipping_rounding_amount, shipping_benefit_amount)
      values
        (1, 'pagado', 10000, 10000, 10000, 3, 300, -300, 0),
        (2, 'entregado', 14000, 11000, 14000, 3, 420, -420, 3000),
        (3, 'enviado', 14000, 14000, 13000, 5, 650, 350, 0),
        (4, 'cancelado', 99000, 99000, 90000, 5, 4500, 4500, 0)`)
    await db.exec("update ordenes set shipping_parcel_quote_status='quoted', shipping_parcel_quote_amount=10380 where id=1")
    const summary = (await db.query<{ s: Record<string, number> }>("select admin_logistics_summary(now() - interval '1 day', now() + interval '1 day') s")).rows[0].s
    assert.equal(Number(summary.markupCollected), 1_370)
    assert.equal(Number(summary.providerQuoted), 37_000)
    assert.equal(Number(summary.chargedToCustomers), 35_000)
    assert.equal(Number(summary.benefitAbsorbed), 3_000)
    assert.equal(Number(summary.parcelQuoted), 10_380)
    assert.equal(Number(summary.parcelQuoteDifference), 380)
    assert.equal(Number(summary.soldOrders), 3)
    assert.equal(Number(summary.billedOrders), 0)
    const access = (await db.query<{ ok: boolean }>("select has_function_privilege('authenticated','public.admin_logistics_summary(timestamptz,timestamptz)','EXECUTE') ok")).rows[0]
    assert.equal(access.ok, false)
  } finally { await db.close() }
})
