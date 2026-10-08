import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8")
const actor = "20000000-0000-4000-8000-000000000002"
let requestNumber = 0
const key = () => `30000000-0000-4000-8000-${String(++requestNumber).padStart(12, "0")}`

async function setup() {
  const db = new PGlite()
  await db.exec(read("lib/orders/fixtures/dispatch-schema.sql"))
  await db.exec(read("supabase/migrations/20260820120000_cost_catalog_barcode.sql"))
  await db.exec(read("supabase/migrations/20261005100000_dispatch_operations.sql"))
  await db.exec(read("supabase/migrations/20261005110000_dispatch_guards.sql"))
  await db.exec(read("supabase/migrations/20261007100000_barcodes_parcels_dispatch.sql"))
  // Funciones de armado redefinidas por la migración de catálogo (alias y
  // venta aleatoria): las reglas existentes tienen que seguir valiendo.
  await db.exec(`
    alter table productos add column activo boolean not null default true, add column stock integer not null default 0;
    alter table producto_variantes add column activo boolean not null default true, add column stock integer not null default 0;
    alter table catalog_sku_registry add column conditioned_stock_id uuid;
    create table stock_reservations (session_id text, product_id bigint, variant_id bigint,
      conditioned_stock_id uuid, quantity integer, expires_at timestamptz, order_id bigint);
    create table checkout_reservation_sessions (session_id text primary key, user_id uuid, order_id bigint,
      reservation_started_at timestamptz, expires_at timestamptz);
  `)
  await db.exec(read("supabase/migrations/20261008120000_catalog_random_dual_color_barcode_aliases.sql"))
  await db.query("select set_config('request.jwt.claim.role','service_role',false)")
  await db.query("insert into profiles(id,rol) values ($1,'operador')", [actor])
  await db.exec("insert into productos(id,sku,codigo_barra,nombre) values (1,'SKU-A','BAR-A','Auriculares Pro'),(2,'SKU-B','BAR-B','Ñandú lámpara'),(3,'SKU-C',null,'Cable')")
  await db.exec("insert into producto_variantes values (11,1,'SKU-A-RED','BAR-A-RED'),(12,1,'SKU-A-BLUE','BAR-A-BLUE'),(31,3,'SKU-C-1',null)")
  await db.exec("insert into catalog_sku_registry values ('SKU-A',1,null),('SKU-B',2,null),('SKU-C',3,null),('SKU-A-RED',null,11),('SKU-A-BLUE',null,12),('SKU-C-1',null,31)")
  await db.exec("insert into ordenes(id) values (1031),(1032)")
  await db.exec("insert into orden_items(id,orden_id,producto_id,variante_id,cantidad) values (1,1031,1,11,2),(2,1031,2,null,1),(3,1032,1,12,1)")
  return db
}

async function prepare(db: PGlite, orderId: number, scans: Array<[number,string]>, parcels: number | null = 1) {
  await db.query("select (begin_order_preparation($1,$2)).id", [orderId, actor])
  for (const [itemId, code] of scans) {
    await db.query("select (scan_order_preparation_item($1,$2,$3,$4,$5)).status", [orderId,itemId,code,actor,key()])
  }
  if (parcels) await db.query("select set_order_package_parcels($1,$2,$3,$4)", [orderId, parcels, actor, key()])
}

async function parcelCodes(db: PGlite, orderId: number) {
  return (await db.query<{ barcode: string }>("select p.barcode from order_package_parcels p join order_packages k on k.id=p.package_id and k.attempt_number=p.attempt_number where p.order_id=$1 order by p.parcel_index", [orderId])).rows.map((row) => row.barcode)
}

type ParcelScan = { orderId: number; parcelIndex: number; parcelCount: number; scannedCount: number; complete: boolean; duplicate: boolean }
async function scanParcel(db: PGlite, batchId: number, code: string, requestKey = key()) {
  return (await db.query<{ result: ParcelScan }>("select scan_dispatch_parcel($1,$2,$3,$4) result", [batchId, code, actor, requestKey])).rows[0].result
}

async function loadOrder(db: PGlite, batchId: number, orderId: number) {
  for (const code of await parcelCodes(db, orderId)) await scanParcel(db, batchId, code)
}

async function newBatch(db: PGlite) {
  return (await db.query<{ id: number; code: string }>("select (create_dispatch_batch($1,$2)).*", [actor, key()])).rows[0]
}

test("preparation validates variant, SKU, exact quantities and duplicate scan keys", async () => {
  const db = await setup()
  try {
    await db.query("select begin_order_preparation($1,$2)", [1031,actor])
    await assert.rejects(db.query("select scan_order_preparation_item($1,$2,$3,$4,$5)", [1031,1,"SKU-A-BLUE",actor,key()]), /DISPATCH_WRONG_SKU_OR_VARIANT/)
    await assert.rejects(db.query("select scan_order_preparation_item($1,$2,$3,$4,$5)", [1031,1,"SKU-B",actor,key()]), /DISPATCH_WRONG_SKU_OR_VARIANT/)
    const scanKey = key()
    await db.query("select scan_order_preparation_item($1,$2,$3,$4,$5)", [1031,1,"BAR-A-RED",actor,scanKey])
    await db.query("select scan_order_preparation_item($1,$2,$3,$4,$5)", [1031,1,"BAR-A-RED",actor,scanKey])
    await assert.rejects(db.query("select scan_order_preparation_item($1,$2,$3,$4,$5)", [1031,2,"SKU-B",actor,scanKey]),/DISPATCH_SCAN_KEY_CONFLICT/)
    assert.equal((await db.query<{ scanned_quantity: number }>("select scanned_quantity from order_preparation_lines where order_item_id=1")).rows[0].scanned_quantity,1)
    await db.query("select scan_order_preparation_item($1,$2,$3,$4,$5)", [1031,1,"SKU-A-RED",actor,key()])
    await assert.rejects(db.query("select scan_order_preparation_item($1,$2,$3,$4,$5)", [1031,1,"SKU-A-RED",actor,key()]), /DISPATCH_QUANTITY_EXCEEDED/)
    await db.query("select scan_order_preparation_item($1,$2,$3,$4,$5)", [1031,2,"SKU-B",actor,key()])
    assert.equal((await db.query<{ status: string }>("select status from order_packages where order_id=1031")).rows[0].status,"prepared")
  } finally { await db.close() }
})

test("scan by code resolves the line server-side and distinguishes unknown, foreign and complete", async () => {
  const db = await setup()
  try {
    await db.query("select begin_order_preparation($1,$2)", [1031,actor])
    const scan = (code: string, requestKey = key()) => db.query<{ r: { scanned: number; expected: number; status: string; duplicate: boolean } }>("select scan_order_preparation_code($1,$2,$3,$4) r", [1031,code,actor,requestKey])
    await assert.rejects(scan("NO-EXISTE-999"), /DISPATCH_CODE_UNKNOWN/)
    await assert.rejects(scan("BAR-A-BLUE"), /DISPATCH_WRONG_SKU_OR_VARIANT/)
    await assert.rejects(scan("BX-PKG-2031-01"), /DISPATCH_CODE_NOT_PRODUCT/)
    const repeated = key()
    assert.equal((await scan("BAR-A-RED", repeated)).rows[0].r.scanned, 1)
    const retry = (await scan("BAR-A-RED", repeated)).rows[0].r
    assert.deepEqual([retry.scanned, retry.duplicate], [1, true])
    assert.equal((await scan("sku-a-red")).rows[0].r.scanned, 2)
    await assert.rejects(scan("BAR-A-RED"), /DISPATCH_QUANTITY_EXCEEDED/)
    assert.equal((await scan("BAR-B")).rows[0].r.status, "prepared")
    await assert.rejects(scan("BAR-B"), /DISPATCH_ALREADY_PREPARED/)
    assert.equal((await db.query<{ n: number }>("select count(*)::int n from order_preparation_scans")).rows[0].n, 3)
    // Mismo SKU en dos líneas del pedido: completa primero la línea incompleta.
    await db.exec("insert into orden_items(id,orden_id,producto_id,variante_id,cantidad) values (4,1032,1,12,1)")
    await db.query("select begin_order_preparation($1,$2)", [1032,actor])
    const sameSku = async () => (await db.query<{ r: { orderItemId: number } }>("select scan_order_preparation_code($1,$2,$3,$4) r", [1032,"SKU-A-BLUE",actor,key()])).rows[0].r.orderItemId
    assert.deepEqual([await sameSku(), await sameSku()], [3, 4])
  } finally { await db.close() }
})

test("parcels: defined after armado, unique codes, idempotent, locked once scanned", async () => {
  const db = await setup()
  try {
    await db.query("select begin_order_preparation($1,$2)", [1031,actor])
    await assert.rejects(db.query("select set_order_package_parcels($1,$2,$3,$4)", [1031,2,actor,key()]), /DISPATCH_PACKAGE_NOT_PREPARED/)
    await prepare(db, 1032, [[3,"SKU-A-BLUE"]], null)
    await assert.rejects(db.query("select set_order_package_parcels($1,$2,$3,$4)", [1032,0,actor,key()]), /DISPATCH_PARCEL_COUNT_INVALID/)
    const parcelsKey = key()
    await db.query("select set_order_package_parcels($1,$2,$3,$4)", [1032,3,actor,parcelsKey])
    await db.query("select set_order_package_parcels($1,$2,$3,$4)", [1032,3,actor,parcelsKey])
    await db.query("select set_order_package_parcels($1,$2,$3,$4)", [1032,3,actor,key()])
    await assert.rejects(db.query("select set_order_package_parcels($1,$2,$3,$4)", [1032,2,actor,parcelsKey]), /DISPATCH_SCAN_KEY_CONFLICT/)
    assert.deepEqual(await parcelCodes(db, 1032), ["BX-PKG-2032-01","BX-PKG-2032-02","BX-PKG-2032-03"])
    await db.query("select set_order_package_parcels($1,$2,$3,$4)", [1032,2,actor,key()])
    assert.deepEqual(await parcelCodes(db, 1032), ["BX-PKG-2032-01","BX-PKG-2032-02"])
    assert.equal((await db.query<{ n: number }>("select count(*)::int n from order_audit_events where order_id=1032 and action='order_parcels_defined'")).rows[0].n, 2)
    const batch = await newBatch(db)
    const first = await scanParcel(db, batch.id, "bx-pkg-2032-01")
    assert.deepEqual([first.orderId, first.parcelIndex, first.parcelCount, first.scannedCount, first.complete], [1032,1,2,1,false])
    await assert.rejects(db.query("select set_order_package_parcels($1,$2,$3,$4)", [1032,4,actor,key()]), /DISPATCH_PARCELS_LOCKED/)
    await assert.rejects(db.exec("insert into order_package_parcels(package_id,order_id,attempt_number,parcel_index,parcel_count,barcode,created_by) select package_id,order_id,attempt_number,9,9,barcode,created_by from order_package_parcels limit 1"), /duplicate key/)
  } finally { await db.close() }
})

test("lot scanning: duplicates are idempotent, other lot and stale labels are rejected, close needs every parcel", async () => {
  const db = await setup()
  try {
    await prepare(db, 1031, [[1,"SKU-A-RED"],[1,"SKU-A-RED"],[2,"SKU-B"]], 3)
    await prepare(db, 1032, [[3,"SKU-A-BLUE"]], 1)
    const lot = await newBatch(db)
    const other = await newBatch(db)
    const [p1, p2, p3] = await parcelCodes(db, 1031)
    const repeatKey = key()
    await scanParcel(db, lot.id, p1, repeatKey)
    const retried = await scanParcel(db, lot.id, p1, repeatKey)
    assert.equal(retried.duplicate, true)
    const again = await scanParcel(db, lot.id, p1)
    assert.deepEqual([again.duplicate, again.scannedCount], [true, 1])
    await assert.rejects(scanParcel(db, lot.id, p2, repeatKey), /DISPATCH_SCAN_KEY_CONFLICT/)
    await assert.rejects(scanParcel(db, other.id, p2), /DISPATCH_PARCEL_OTHER_BATCH/)
    await assert.rejects(scanParcel(db, lot.id, "BX-PKG-9999-01"), /DISPATCH_PARCEL_UNKNOWN/)
    await assert.rejects(scanParcel(db, lot.id, "BAR-A-RED"), /DISPATCH_CODE_IS_PRODUCT/)
    await assert.rejects(scanParcel(db, lot.id, lot.code), /DISPATCH_CODE_IS_BATCH/)
    await assert.rejects(scanParcel(db, lot.id, "ZZZ"), /DISPATCH_CODE_UNKNOWN/)
    await scanParcel(db, lot.id, p2)
    await assert.rejects(db.query("select close_dispatch_batch($1,$2)", [lot.id, actor]), /DISPATCH_PARCELS_MISSING/)
    const last = await scanParcel(db, lot.id, p3)
    assert.deepEqual([last.parcelIndex, last.scannedCount, last.complete], [3, 3, true])
    await db.query("select add_order_to_dispatch_batch($1,$2,$3)", [lot.id, 1032, actor])
    await assert.rejects(db.query("select close_dispatch_batch($1,$2)", [lot.id, actor]), /DISPATCH_PARCELS_MISSING/)
    await loadOrder(db, lot.id, 1032)
    await db.query("select close_dispatch_batch($1,$2)", [lot.id, actor])
    await db.query("select close_dispatch_batch($1,$2)", [lot.id, actor])
    assert.equal((await db.query<{ n: number }>("select count(*)::int n from dispatch_batch_events where batch_id=$1 and action='closed'", [lot.id])).rows[0].n, 1)
    assert.ok((await db.query<{ closed_at: string | null }>("select closed_at from dispatch_batches where id=$1", [lot.id])).rows[0].closed_at)
    await assert.rejects(scanParcel(db, lot.id, p1, key()), /DISPATCH_BATCH_CLOSED/)
    await db.query("select hand_over_dispatch_batch($1,$2)", [lot.id, actor])
    assert.equal((await db.query<{ n: number }>("select count(*)::int n from ordenes where andreani_handed_over_batch_id=$1", [lot.id])).rows[0].n, 2)
  } finally { await db.close() }
})

test("lot only accepts complete orders with parcels; create with selection is all-or-nothing", async () => {
  const db = await setup()
  try {
    await prepare(db, 1031, [[1,"SKU-A-RED"],[1,"SKU-A-RED"],[2,"SKU-B"]], null)
    await prepare(db, 1032, [[3,"SKU-A-BLUE"]], 2)
    const batch = await newBatch(db)
    await assert.rejects(db.query("select add_order_to_dispatch_batch($1,$2,$3)", [batch.id, 1031, actor]), /DISPATCH_PARCELS_PENDING/)
    const createKey = key()
    await assert.rejects(db.query("select create_dispatch_batch_with_orders($1,$2,$3)", [actor, createKey, [1032, 1031]]), (error: { message: string; detail?: string }) => /DISPATCH_PARCELS_PENDING/.test(error.message) && error.detail === "1031")
    assert.equal((await db.query<{ n: number }>("select count(*)::int n from dispatch_batches")).rows[0].n, 1)
    await db.query("select set_order_package_parcels($1,$2,$3,$4)", [1031, 1, actor, key()])
    const created = (await db.query<{ id: number }>("select (create_dispatch_batch_with_orders($1,$2,$3)).id", [actor, createKey, [1032, 1031, 1032]])).rows[0]
    const retried = (await db.query<{ id: number }>("select (create_dispatch_batch_with_orders($1,$2,$3)).id", [actor, createKey, [1032, 1031]])).rows[0]
    assert.equal(created.id, retried.id)
    assert.equal((await db.query<{ n: number }>("select count(*)::int n from dispatch_batch_items where batch_id=$1 and removed_at is null", [created.id])).rows[0].n, 2)
    await assert.rejects(db.query("select create_dispatch_batch_with_orders($1,$2,$3)", [actor, key(), []]), /DISPATCH_BATCH_EMPTY/)
  } finally { await db.close() }
})

test("cancellation after armado blocks the lot and keeps parcels for withdrawal; reset voids old labels", async () => {
  const db = await setup()
  try {
    await prepare(db, 1032, [[3,"SKU-A-BLUE"]], 2)
    const lot = await newBatch(db)
    await loadOrder(db, lot.id, 1032)
    await db.exec("update ordenes set estado='cancelado',cancelled_at=now(),financial_status='refund_pending' where id=1032")
    assert.equal((await db.query<{ n: number }>("select count(*)::int n from dispatch_blocks where order_id=1032 and reason='cancelled' and resolved_at is null")).rows[0].n, 1)
    await assert.rejects(db.query("select close_dispatch_batch($1,$2)", [lot.id, actor]), /DISPATCH_ORDER_BLOCKED/)
    const [first] = await parcelCodes(db, 1032)
    await assert.rejects(scanParcel(db, lot.id, first), /DISPATCH_ORDER_BLOCKED/)
    assert.equal((await db.query<{ n: number }>("select count(*)::int n from mercadopago_order_refunds where order_id=1032")).rows[0].n, 0)
    await db.query("select remove_order_from_dispatch_batch($1,$2,$3,$4)", [lot.id, 1032, actor, "Pedido cancelado, retirar bultos"])
    await db.exec("update ordenes set estado='pagado',cancelled_at=null,financial_status='payment_confirmed' where id=1032")
    await db.query("select reset_order_preparation($1,$2,$3,$4)", [1032, actor, key(), "Rearmar el pedido completo"])
    assert.equal((await db.query<{ parcel_count: number | null }>("select parcel_count from order_packages where order_id=1032")).rows[0].parcel_count, null)
    await db.query("select scan_order_preparation_item($1,$2,$3,$4,$5)", [1032, 3, "SKU-A-BLUE", actor, key()])
    await db.query("select set_order_package_parcels($1,$2,$3,$4)", [1032, 1, actor, key()])
    assert.deepEqual(await parcelCodes(db, 1032), ["BX-PKG-2032-R2-01"])
    const next = await newBatch(db)
    await assert.rejects(scanParcel(db, next.id, first), /DISPATCH_PARCEL_STALE/)
    await scanParcel(db, next.id, "BX-PKG-2032-R2-01")
    await db.query("select close_dispatch_batch($1,$2)", [next.id, actor])
  } finally { await db.close() }
})

test("BEYONIX barcode: generated once, never overwrites manufacturer codes, origin derived, prefixes reserved", async () => {
  const db = await setup()
  try {
    const generate = (productId: number, variantId: number) => db.query<{ codigo_barra: string; codigo_barra_origen: string }>("select (v).codigo_barra, (v).codigo_barra_origen from (select generate_beyonix_variant_barcode($1,$2,$3) v) s", [productId, variantId, actor])
    const manufacturer = (await generate(1, 11)).rows[0]
    assert.deepEqual(manufacturer, { codigo_barra: "BAR-A-RED", codigo_barra_origen: "fabricante" })
    await db.exec("update producto_variantes set codigo_barra=null where id=12")
    await db.exec("insert into producto_variantes values (13,1,'SKU-A-X','BX-AUR-000002'),(14,1,'SKU-A-Y',null)")
    const generated = (await generate(1, 12)).rows[0]
    assert.deepEqual(generated, { codigo_barra: "BX-AUR-000001", codigo_barra_origen: "beyonix" })
    assert.equal((await generate(1, 12)).rows[0].codigo_barra, "BX-AUR-000001")
    // 000002 ya fue cargado a mano: el generador saltea al siguiente número libre.
    assert.equal((await generate(1, 14)).rows[0].codigo_barra, "BX-AUR-000003")
    assert.equal((await generate(3, 31)).rows[0].codigo_barra, "BX-CAB-000004")
    assert.equal((await db.query<{ p: string }>("select beyonix_barcode_prefix('Ñandú') p")).rows[0].p, "NAN")
    assert.equal((await db.query<{ p: string }>("select beyonix_barcode_prefix('4K') p")).rows[0].p, "GEN")
    assert.equal((await db.query<{ p: string }>("select beyonix_barcode_prefix('Pkg box') p")).rows[0].p, "GEN")
    await assert.rejects(db.exec("update producto_variantes set codigo_barra='BAR-A-RED' where id=31"), /ya está asignado/)
    await assert.rejects(db.exec("update producto_variantes set codigo_barra='BX-PKG-2031-01' where id=31"), /reserved_check/)
    await assert.rejects(db.exec("update producto_variantes set codigo_barra='DSP-20261007-001' where id=31"), /reserved_check/)
    await assert.rejects(db.query("select generate_beyonix_variant_barcode($1,$2,$3)", [1, 99, actor]), /ya no existe/)
    await db.query("select set_config('request.jwt.claim.role','authenticated',false)")
    await assert.rejects(db.query("select generate_beyonix_variant_barcode($1,$2,$3)", [1, 12, actor]), /permisos/)
  } finally { await db.close() }
})

test("payment reversal and manual block stop a closed batch; resolution remains audited", async () => {
  const db=await setup()
  try {
    await prepare(db,1032,[[3,"SKU-A-BLUE"]])
    const batch=await newBatch(db)
    await loadOrder(db,batch.id,1032)
    await db.query("select close_dispatch_batch($1,$2)",[batch.id,actor])
    await db.query("select set_dispatch_manual_block($1,$2,$3,$4)",[1032,actor,"Retener por control interno",true])
    await assert.rejects(db.query("select hand_over_dispatch_batch($1,$2)",[batch.id,actor]),/DISPATCH_ORDER_BLOCKED/)
    await db.query("select set_dispatch_manual_block($1,$2,$3,$4)",[1032,actor,"Retener por control interno",false])
    await db.query("select set_dispatch_manual_block($1,$2,$3,$4)",[1032,actor,"Retener por control interno",false])
    await db.exec("update ordenes set financial_status='refund_pending' where id=1032")
    await assert.rejects(db.query("select hand_over_dispatch_batch($1,$2)",[batch.id,actor]),/DISPATCH_ORDER_BLOCKED/)
    assert.equal((await db.query<{n:number}>("select count(*)::int n from dispatch_blocks where order_id=1032 and reason='financial_conflict' and resolved_at is null")).rows[0].n,1)
    await db.exec("update ordenes set financial_status='payment_confirmed' where id=1032")
    assert.equal((await db.query<{n:number}>("select count(*)::int n from dispatch_blocks where order_id=1032 and resolved_at is null")).rows[0].n,0)
    await db.query("select hand_over_dispatch_batch($1,$2)",[batch.id,actor])
    assert.equal((await db.query<{n:number}>("select count(*)::int n from order_audit_events where order_id=1032 and action in ('dispatch_block_added','dispatch_block_resolved')")).rows[0].n,2)
    await assert.rejects(db.exec("update ordenes set andreani_handed_over_at=null where id=1032"),/DISPATCH_HANDOVER_IMMUTABLE/)
  } finally { await db.close() }
})

test("refund in progress blocks delivery, and request cannot begin after physical handover", async () => {
  const db=await setup()
  try {
    await prepare(db,1032,[[3,"SKU-A-BLUE"]])
    const batch=await newBatch(db)
    await loadOrder(db,batch.id,1032)
    await db.query("select close_dispatch_batch($1,$2)",[batch.id,actor])
    await db.exec("insert into mercadopago_order_refunds(order_id,status) values (1032,'processing')")
    await assert.rejects(db.query("select hand_over_dispatch_batch($1,$2)",[batch.id,actor]),/DISPATCH_ORDER_BLOCKED/)
    await db.exec("update mercadopago_order_refunds set status='failed' where order_id=1032")
    await db.query("select hand_over_dispatch_batch($1,$2)",[batch.id,actor])
    await assert.rejects(db.exec("insert into mercadopago_order_refunds(order_id,status,automation_mode) values (1032,'requested','automatic')"),/DISPATCH_REFUND_AFTER_HANDOVER/)
  } finally { await db.close() }
})

test("cancellation or item change before handover raises a durable dispatch hold", async () => {
  const db=await setup()
  try {
    await prepare(db,1032,[[3,"SKU-A-BLUE"]])
    const batch=await newBatch(db)
    await loadOrder(db,batch.id,1032)
    await db.query("select close_dispatch_batch($1,$2)",[batch.id,actor])
    await db.exec("update orden_items set cantidad=2 where id=3")
    assert.equal((await db.query<{n:number}>("select count(*)::int n from dispatch_blocks where order_id=1032 and reason='items_changed' and resolved_at is null")).rows[0].n,1)
    await assert.rejects(db.query("select hand_over_dispatch_batch($1,$2)",[batch.id,actor]),/DISPATCH_ORDER_BLOCKED/)
    await db.exec("update orden_items set cantidad=1 where id=3")
    await db.exec("update ordenes set estado='cancelado',cancelled_at=now(),financial_status='refund_pending' where id=1032")
    assert.equal((await db.query<{n:number}>("select count(*)::int n from dispatch_blocks where order_id=1032 and reason='cancelled' and resolved_at is null")).rows[0].n,1)
    await assert.rejects(db.query("select hand_over_dispatch_batch($1,$2)",[batch.id,actor]),/DISPATCH_ORDER_BLOCKED/)
  } finally { await db.close() }
})

test("packing may start while invoice or label is pending, but batch inclusion waits", async () => {
  const db=await setup()
  try {
    await db.exec("update ordenes set invoice_status='pending',invoice_cae=null,andreani_envio_id=null,andreani_creation_status=null where id=1032")
    await prepare(db,1032,[[3,"SKU-A-BLUE"]])
    const batch=await newBatch(db)
    await assert.rejects(db.query("select add_order_to_dispatch_batch($1,$2,$3)",[batch.id,1032,actor]),/DISPATCH_ORDER_BLOCKED/)
    const [parcel]=await parcelCodes(db,1032)
    await assert.rejects(scanParcel(db,batch.id,parcel),/DISPATCH_ORDER_BLOCKED/)
    await db.exec("update ordenes set invoice_status='authorized',invoice_cae='CAE-TEST',andreani_envio_id='AND-TEST',andreani_creation_status='created' where id=1032")
    await db.query("select add_order_to_dispatch_batch($1,$2,$3)",[batch.id,1032,actor])
  } finally { await db.close() }
})

test("changed order can be re-prepared after controlled removal without losing scan history", async () => {
  const db=await setup()
  try {
    await prepare(db,1032,[[3,"SKU-A-BLUE"]])
    const batch=await newBatch(db)
    await loadOrder(db,batch.id,1032)
    await db.query("select close_dispatch_batch($1,$2)",[batch.id,actor])
    await db.exec("update orden_items set cantidad=2 where id=3")
    const resetKey=key()
    await assert.rejects(db.query("select reset_order_preparation($1,$2,$3,$4)",[1032,actor,resetKey,"Se agrego una unidad al pedido"]),/DISPATCH_RESET_REQUIRES_REMOVAL/)
    await db.query("select remove_order_from_dispatch_batch($1,$2,$3,$4)",[batch.id,1032,actor,"Pedido modificado antes del despacho"])
    await db.query("select reset_order_preparation($1,$2,$3,$4)",[1032,actor,resetKey,"Se agrego una unidad al pedido"])
    await db.query("select reset_order_preparation($1,$2,$3,$4)",[1032,actor,resetKey,"Se agrego una unidad al pedido"])
    assert.equal((await db.query<{attempt_number:number}>("select attempt_number from order_packages where order_id=1032")).rows[0].attempt_number,2)
    assert.equal((await db.query<{n:number}>("select count(*)::int n from order_preparation_scans where package_id=(select id from order_packages where order_id=1032)")).rows[0].n,1)
    await db.query("select scan_order_preparation_item($1,$2,$3,$4,$5)",[1032,3,"SKU-A-BLUE",actor,key()])
    await db.query("select scan_order_preparation_item($1,$2,$3,$4,$5)",[1032,3,"SKU-A-BLUE",actor,key()])
    assert.equal((await db.query<{status:string}>("select status from order_packages where order_id=1032")).rows[0].status,"prepared")
    assert.equal((await db.query<{n:number}>("select count(*)::int n from order_preparation_scans where package_id=(select id from order_packages where order_id=1032)")).rows[0].n,3)
    assert.equal((await db.query<{n:number}>("select count(*)::int n from dispatch_blocks where order_id=1032 and resolved_at is null")).rows[0].n,0)
    assert.equal((await db.query<{n:number}>("select count(*)::int n from order_package_parcels where order_id=1032")).rows[0].n,1)
  } finally { await db.close() }
})

test("dispatch tables enforce RLS and RPCs reject untrusted callers", async () => {
  const db=await setup()
  try {
    const access=(await db.query<{rls:boolean;table_write:boolean;rpc_execute:boolean;parcel_rls:boolean;parcel_write:boolean;scan_rpc:boolean}>(`
      select c.relrowsecurity rls,
        has_table_privilege('authenticated','public.dispatch_batches','INSERT') table_write,
        has_function_privilege('authenticated','public.hand_over_dispatch_batch(bigint,uuid)','EXECUTE') rpc_execute,
        (select relrowsecurity from pg_class where oid='public.order_package_parcels'::regclass) parcel_rls,
        has_table_privilege('authenticated','public.order_package_parcels','INSERT') parcel_write,
        has_function_privilege('authenticated','public.scan_dispatch_parcel(bigint,text,uuid,uuid)','EXECUTE') scan_rpc
      from pg_class c where c.oid='public.dispatch_batches'::regclass
    `)).rows[0]
    assert.deepEqual(access,{rls:true,table_write:false,rpc_execute:false,parcel_rls:true,parcel_write:false,scan_rpc:false})
    await db.query("select set_config('request.jwt.claim.role','authenticated',false)")
    await assert.rejects(db.query("select begin_order_preparation($1,$2)",[1031,actor]),/DISPATCH_FORBIDDEN/)
    await assert.rejects(db.query("select set_order_package_parcels($1,$2,$3,$4)",[1031,1,actor,key()]),/DISPATCH_FORBIDDEN/)
  } finally { await db.close() }
})

test("batch code, active uniqueness, claim block, removal and atomic handover", async () => {
  const db = await setup()
  try {
    await prepare(db,1031,[[1,"SKU-A-RED"],[1,"SKU-A-RED"],[2,"SKU-B"]])
    await prepare(db,1032,[[3,"SKU-A-BLUE"]])
    const batchKey=key()
    const first=(await db.query<{id:number;code:string}>("select (create_dispatch_batch($1,$2)).*",[actor,batchKey])).rows[0]
    assert.match(first.code,/^DSP-\d{8}-001$/)
    assert.equal((await db.query<{id:number}>("select (create_dispatch_batch($1,$2)).id",[actor,batchKey])).rows[0].id,first.id)
    const second=await newBatch(db)
    await loadOrder(db,first.id,1031)
    await loadOrder(db,first.id,1032)
    await assert.rejects(db.query("select add_order_to_dispatch_batch($1,$2,$3)",[second.id,1031,actor]),/duplicate key/)
    await db.query("select close_dispatch_batch($1,$2)",[first.id,actor])
    await db.exec("insert into order_claims(order_id) values (1031)")
    await assert.rejects(db.query("select hand_over_dispatch_batch($1,$2)",[first.id,actor]),/DISPATCH_ORDER_BLOCKED/)
    assert.equal((await db.query<{n:number}>("select count(*)::int n from dispatch_blocks where order_id=1031 and reason='claim' and resolved_at is null")).rows[0].n,1)
    await db.query("select remove_order_from_dispatch_batch($1,$2,$3,$4)",[first.id,1031,actor,"Reclamo abierto, retirar bulto"])
    await db.query("select hand_over_dispatch_batch($1,$2)",[first.id,actor])
    await db.query("select hand_over_dispatch_batch($1,$2)",[first.id,actor])
    const order=(await db.query<{andreani_handed_over_at:string|null}>("select andreani_handed_over_at from ordenes where id=1032")).rows[0]
    assert.ok(order.andreani_handed_over_at)
    assert.equal((await db.query<{n:number}>("select count(*)::int n from order_audit_events where order_id=1032 and action='order_handed_over_to_andreani'")).rows[0].n,1)
    await assert.rejects(db.query("insert into mercadopago_order_refunds(order_id,status,automation_mode) values (1032,'processing','automatic')"),/DISPATCH_REFUND_AFTER_HANDOVER/)
    await assert.rejects(db.query("select set_order_package_parcels($1,$2,$3,$4)",[1032,2,actor,key()]),/DISPATCH_ALREADY_HANDED_OVER|DISPATCH_PARCELS_LOCKED/)
  } finally { await db.close() }
})
