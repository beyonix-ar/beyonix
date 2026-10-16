import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

// Bulto general (dispatch_batches) verificado por BX-PREP e identificación
// física obligatoria (20261016150000), contra las migraciones reales.

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8")
const actor = "20000000-0000-4000-8000-000000000002"
let requestNumber = 0
const key = () => `80000000-0000-4000-8000-${String(++requestNumber).padStart(12, "0")}`

const BASE_SETUP = [
  "lib/orders/fixtures/dispatch-schema.sql",
  "supabase/migrations/20260820120000_cost_catalog_barcode.sql",
  "supabase/migrations/20261005100000_dispatch_operations.sql",
  "supabase/migrations/20261005110000_dispatch_guards.sql",
  "supabase/migrations/20261007100000_barcodes_parcels_dispatch.sql",
  "lib/orders/fixtures/dispatch-inventory-schema.sql",
  "supabase/migrations/20261008120000_catalog_random_dual_color_barcode_aliases.sql",
  "supabase/migrations/20261009100000_random_fulfillment_traceability.sql",
  "supabase/migrations/20260918110000_inventory_refresh_reproducibility.sql",
  "supabase/migrations/20260918100000_refresh_inventory_stock_fail_closed.sql",
  "supabase/migrations/20261016100000_dispatch_cancellation_physical_holds.sql",
  "supabase/migrations/20261016101000_dispatch_hold_check_public_catalog.sql",
  "supabase/migrations/20261016110000_dispatch_hold_from_first_pick.sql",
  "supabase/migrations/20261016120000_cancellation_after_picking_manual_refund.sql",
  "supabase/migrations/20261016130000_picked_cancellation_admin_refund_only.sql",
]
const BUNDLE_MIGRATION = "supabase/migrations/20261016150000_dispatch_general_bundle_verification.sql"

async function setup({ withBundleMigration = true } = {}) {
  const db = new PGlite()
  for (const file of BASE_SETUP) await db.exec(read(file))
  await db.query("select set_config('request.jwt.claim.role','service_role',false)")
  await db.query("insert into profiles(id,rol) values ($1,'operador')", [actor])
  await db.exec(`
    insert into productos(id,sku,codigo_barra,nombre) values (1,'SKU-A','BAR-A','Auriculares Pro'),(2,'SKU-B','BAR-B','Ñandú lámpara');
    insert into producto_variantes(id,producto_id,sku,codigo_barra,nombre) values (11,1,'SKU-A-RED','BAR-A-RED','Rojo'),(12,1,'SKU-A-BLUE','BAR-A-BLUE','Azul');
    insert into catalog_sku_registry(normalized_sku,product_id,variant_id) values ('SKU-A',1,null),('SKU-B',2,null),('SKU-A-RED',null,11),('SKU-A-BLUE',null,12);
    insert into product_cost_entries(product_id,variant_id,received_quantity) values (1,11,2),(1,12,5),(2,null,1);
    insert into ordenes(id) values (1031),(1032),(1033);
    insert into orden_items(id,orden_id,producto_id,variante_id,cantidad) values (1,1031,1,11,2),(2,1031,2,null,1),(3,1032,1,12,1),(4,1033,1,12,1);
  `)
  await db.exec("select refresh_inventory_stock(1); select refresh_inventory_stock(2);")
  if (withBundleMigration) await db.exec(read(BUNDLE_MIGRATION))
  return db
}

const CODES: Record<number, string[]> = { 1031: ["BAR-A-RED", "BAR-A-RED", "BAR-B"], 1032: ["BAR-A-BLUE"], 1033: ["BAR-A-BLUE"] }

async function prepare(db: PGlite, orderId: number, parcels = 1) {
  await db.query("select begin_order_preparation($1,$2)", [orderId, actor])
  for (const code of CODES[orderId]) await db.query("select scan_order_preparation_code($1,$2,$3,$4)", [orderId, code, actor, key()])
  await db.query("select set_order_package_parcels($1,$2,$3,$4)", [orderId, parcels, actor, key()])
}

type Identified = { identification_method: string | null; identified_by: string | null; identified_at: string | null }
const identify = async (db: PGlite, orderId: number, method: "printed" | "manual", code = `BX-PREP-${1000 + orderId}`, requestKey = key()) =>
  (await db.query<Identified>("select (r).identification_method, (r).identified_by, (r).identified_at from (select confirm_order_physical_identification($1,$2,$3,$4,$5) r) s", [orderId, code, method, actor, requestKey])).rows[0]

const newBatch = async (db: PGlite, orderIds: number[]) =>
  (await db.query<{ id: number; code: string }>("select (create_dispatch_batch_with_orders($1,$2,$3)).*", [actor, key(), orderIds])).rows[0]

type Verify = { orderId: number; code: string; method: string; duplicate: boolean; expected: number; verified: number }
const verify = async (db: PGlite, batchId: number, code: string | null, method: string, requestKey = key(), orderId: number | null = null) =>
  (await db.query<{ r: Verify }>("select verify_dispatch_batch_order($1,$2,$3,$4,$5,$6) r", [batchId, code, method, actor, requestKey, orderId])).rows[0].r

const count = async (db: PGlite, sql: string, params: unknown[] = []) => (await db.query<{ n: number }>(sql, params)).rows[0].n
const cancel = (db: PGlite, orderId: number) => db.query(
  "update ordenes set estado='cancelado',cancelled_at=now(),financial_status='refund_pending',cancellation_requested_at=now(),refund_pending_at=now() where id=$1",
  [orderId])

test("identificación física: impresa o manual, obligatoria para el Bulto general y anulada al rearmar", async () => {
  const db = await setup()
  try {
    await prepare(db, 1031)
    await prepare(db, 1032)
    const empty = (await db.query<{ id: number }>("select (create_dispatch_batch($1,$2)).id", [actor, key()])).rows[0]
    await assert.rejects(db.query("select add_order_to_dispatch_batch($1,$2,$3)", [empty.id, 1031, actor]), /DISPATCH_IDENTIFICATION_PENDING/, "sin identificación no entra")
    await assert.rejects(newBatch(db, [1031]), /DISPATCH_IDENTIFICATION_PENDING/)
    await assert.rejects(identify(db, 1031, "printed", "BX-PREP-2031-R2"), /DISPATCH_PREP_STALE/, "sólo el código vigente")
    await assert.rejects(identify(db, 1031, "printed", "BX-PREP-2032"), /DISPATCH_PREP_STALE/)
    await assert.rejects(db.query("select confirm_order_physical_identification($1,$2,'otro',$3,$4)", [1031, "BX-PREP-2031", actor, key()]), /DISPATCH_SCAN_INVALID/)

    const printedKey = key()
    const printed = await identify(db, 1031, "printed", " bx-prep-2031 ", printedKey)
    assert.deepEqual([printed.identification_method, printed.identified_by], ["printed", actor])
    assert.ok(printed.identified_at)
    assert.equal(String((await identify(db, 1031, "printed", "BX-PREP-2031", printedKey)).identified_at), String(printed.identified_at), "mismo request_key: idempotente")
    assert.equal((await identify(db, 1031, "manual")).identification_method, "printed", "reimprimir o reintentar conserva el primer registro")
    assert.equal(await count(db, "select count(*)::int n from order_audit_events where order_id=1031 and action='order_physical_identification_confirmed'"), 1)
    await assert.rejects(db.exec("update order_packages set identification_method='manual' where order_id=1031"), /DISPATCH_IDENTIFICATION_IMMUTABLE/)

    const manual = await identify(db, 1032, "manual")
    assert.equal(manual.identification_method, "manual")
    const audit = (await db.query<{ metadata: { method: string; code: string } }>("select metadata from order_audit_events where order_id=1032 and action='order_physical_identification_confirmed'")).rows[0]
    assert.deepEqual([audit.metadata.method, audit.metadata.code], ["manual", "BX-PREP-2032"])

    // Rearmar invalida la identificación: el BX-PREP pasa a -R2.
    await db.query("select reset_order_preparation($1,$2,$3,$4)", [1031, actor, key(), "Rearmado por control de calidad"])
    assert.equal((await db.query<{ m: string | null }>("select identification_method m from order_packages where order_id=1031")).rows[0].m, null)
    for (const code of CODES[1031]) await db.query("select scan_order_preparation_code($1,$2,$3,$4)", [1031, code, actor, key()])
    await db.query("select set_order_package_parcels($1,$2,$3,$4)", [1031, 1, actor, key()])
    await assert.rejects(identify(db, 1031, "printed", "BX-PREP-2031"), /DISPATCH_PREP_STALE/, "la etiqueta vieja no identifica el rearmado")
    assert.equal((await identify(db, 1031, "printed", "BX-PREP-2031-R2")).identification_method, "printed")
  } finally { await db.close() }
})

test("Bulto general: esperado ≠ verificado, un BX-PREP por pedido, todos los métodos e idempotencia", async () => {
  const db = await setup()
  try {
    for (const orderId of [1031, 1032, 1033]) { await prepare(db, orderId); await identify(db, orderId, "printed") }
    const bundle = await newBatch(db, [1031, 1032])
    const other = await newBatch(db, [1033])
    assert.equal(await count(db, "select count(*)::int n from dispatch_batch_items where batch_id=$1 and removed_at is null and verified_at is null", [bundle.id]), 2, "seleccionar no verifica")
    await assert.rejects(db.query("select close_dispatch_batch($1,$2)", [bundle.id, actor]), /DISPATCH_ORDERS_UNVERIFIED/, "cierre bloqueado con faltantes")

    // Códigos incorrectos: avisan sin romper el flujo ni verificar nada.
    for (const [code, error] of [
      ["BX-PKG-2031-01", /DISPATCH_VERIFY_PARCEL_CODE/],
      ["BAR-A-RED", /DISPATCH_CODE_IS_PRODUCT/],
      [bundle.code, /DISPATCH_CODE_IS_BATCH/],
      ["BX-2031", /DISPATCH_VERIFY_LABEL_REQUIRED/],
      ["ZZZ", /DISPATCH_CODE_UNKNOWN/],
      ["BX-PREP-2031-R2", /DISPATCH_PREP_STALE/],
      ["BX-PREP-2099", /DISPATCH_VERIFY_NOT_EXPECTED/],
      ["BX-PREP-2033", /DISPATCH_PREP_OTHER_BATCH/],
      ["BX-PREP-999999999999999", /DISPATCH_VERIFY_NOT_EXPECTED/],
    ] as const) await assert.rejects(verify(db, bundle.id, code, "scanner"), error, code)
    await assert.rejects(verify(db, bundle.id, "BX-PREP-2031", "lector"), /DISPATCH_SCAN_INVALID/)
    await assert.rejects(verify(db, bundle.id, null, "manual_selection"), /DISPATCH_SCAN_INVALID/)
    assert.equal(await count(db, "select count(*)::int n from dispatch_batch_events where batch_id=$1 and action='order_verified'", [bundle.id]), 0)

    const scannerKey = key()
    const first = await verify(db, bundle.id, "BX-PREP-2031", "scanner", scannerKey)
    assert.deepEqual([first.orderId, first.method, first.duplicate, first.verified, first.expected], [1031, "scanner", false, 1, 2])
    assert.equal((await verify(db, bundle.id, "BX-PREP-2031", "scanner", scannerKey)).duplicate, true, "doble lectura: misma clave")
    await assert.rejects(verify(db, bundle.id, "BX-PREP-2032", "scanner", scannerKey), /DISPATCH_SCAN_KEY_CONFLICT/)
    const again = await verify(db, bundle.id, "BX-PREP-2031", "camera")
    assert.deepEqual([again.duplicate, again.method, again.verified], [true, "scanner", 1], "pedido duplicado: conserva la primera verificación")
    assert.equal(await count(db, "select count(*)::int n from dispatch_batch_events where batch_id=$1 and action='order_verified'", [bundle.id]), 1)

    // Selección manual explícita: registra el BX-PREP vigente y el método.
    const manual = await verify(db, bundle.id, null, "manual_selection", key(), 1032)
    assert.deepEqual([manual.orderId, manual.code, manual.method, manual.verified], [1032, "BX-PREP-2032", "manual_selection", 2])
    const rows = (await db.query<{ order_id: number; verified_by: string; verification_method: string; verification_code: string; verification_round: number }>(
      "select order_id,verified_by,verification_method,verification_code,verification_round from dispatch_batch_items where batch_id=$1 order by order_id", [bundle.id])).rows
    assert.deepEqual(rows.map((row) => [row.order_id, row.verified_by, row.verification_method, row.verification_code, row.verification_round]),
      [[1031, actor, "scanner", "BX-PREP-2031", 1], [1032, actor, "manual_selection", "BX-PREP-2032", 1]])

    // Cámara y tipeo/pegado (espacios, minúsculas) usan la misma función.
    const camera = await verify(db, other.id, "BX-PREP-2033", "camera")
    assert.equal(camera.method, "camera")
    await db.query("select close_dispatch_batch($1,$2)", [other.id, actor])

    const pasteDb = await setup()
    try {
      await prepare(pasteDb, 1032); await identify(pasteDb, 1032, "manual")
      const pasted = await newBatch(pasteDb, [1032])
      assert.equal((await verify(pasteDb, pasted.id, "  bx-prep-2032\t", "manual_code")).method, "manual_code")
    } finally { await pasteDb.close() }

    // Directo a la tabla tampoco se puede inventar una verificación ni tocar la pertenencia.
    await assert.rejects(db.exec(`update dispatch_batch_items set order_id=1033 where batch_id=${bundle.id} and order_id=1031`), /DISPATCH_MEMBERSHIP_IMMUTABLE/)
    await assert.rejects(db.exec(`update dispatch_batch_items set verified_by='${key()}' where batch_id=${bundle.id} and order_id=1031`), /DISPATCH_MEMBERSHIP_IMMUTABLE/)

    // Cerrado ≠ entregado: la entrega exige el DSP de este Bulto general.
    const closed = (await db.query<{ status: string; handed_over_at: string | null }>("select (close_dispatch_batch($1,$2)).status, (close_dispatch_batch($1,$2)).handed_over_at", [bundle.id, actor])).rows[0]
    assert.deepEqual([closed.status, closed.handed_over_at], ["closed", null])
    assert.equal(await count(db, "select count(*)::int n from ordenes where id in (1031,1032) and andreani_handed_over_at is not null"), 0)
    await assert.rejects(db.query("select confirm_dispatch_batch_handover($1,$2,$3)", [bundle.id, other.code, actor]), /DISPATCH_HANDOVER_CODE_MISMATCH/)
    const handed = (await db.query<{ r: { duplicate: boolean } }>("select confirm_dispatch_batch_handover($1,$2,$3) r", [bundle.id, ` ${bundle.code.toLowerCase()} `, actor])).rows[0].r
    assert.equal(handed.duplicate, false)
    assert.equal((await db.query<{ r: { duplicate: boolean } }>("select confirm_dispatch_batch_handover($1,$2,$3) r", [bundle.id, bundle.code, actor])).rows[0].r.duplicate, true, "doble lectura del DSP")
    assert.equal(await count(db, "select count(*)::int n from ordenes where id in (1031,1032) and andreani_handed_over_batch_id=$1", [bundle.id]), 2)
    assert.equal(await count(db, "select count(*)::int n from order_audit_events where order_id=1031 and action='order_handed_over_to_andreani'"), 1)
  } finally { await db.close() }
})

test("cancelación dentro del Bulto general abierto: requiere revisión, bloquea el cierre y se retira físicamente", async () => {
  const db = await setup()
  try {
    for (const orderId of [1031, 1032]) { await prepare(db, orderId); await identify(db, orderId, "printed") }
    const bundle = await newBatch(db, [1031, 1032])
    await verify(db, bundle.id, "BX-PREP-2031", "scanner")
    await verify(db, bundle.id, "BX-PREP-2032", "scanner")
    await cancel(db, 1032)
    assert.equal(await count(db, "select count(*)::int n from order_cancellation_holds where order_id=1032 and batch_id=$1 and resolved_at is null", [bundle.id]), 1)
    assert.equal(await count(db, "select count(*)::int n from dispatch_batch_items where batch_id=$1 and order_id=1032 and removed_at is null", [bundle.id]), 1, "no se oculta ni se quita solo")
    await assert.rejects(db.query("select close_dispatch_batch($1,$2)", [bundle.id, actor]), /DISPATCH_ORDER_BLOCKED/)
    assert.equal((await verify(db, bundle.id, "BX-PREP-2032", "scanner")).duplicate, true, "releerlo no lo desbloquea: el bloqueo vive en el cierre")
    await assert.rejects(db.query("select close_dispatch_batch($1,$2)", [bundle.id, actor]), /DISPATCH_ORDER_BLOCKED/)

    await db.query("select resolve_cancelled_order_preparation($1,$2,$3,$4)", ["BX-PREP-2032", actor, key(), 1032])
    assert.equal(await count(db, "select count(*)::int n from dispatch_batch_items where batch_id=$1 and removed_at is null", [bundle.id]), 1, "composición actualizada")
    assert.equal((await db.query<{ r: number }>("select verification_round r from dispatch_batches where id=$1", [bundle.id])).rows[0].r, 1, "abierto: la verificación del resto sigue vigente")
    await db.query("select close_dispatch_batch($1,$2)", [bundle.id, actor])
  } finally { await db.close() }
})

test("cancelación dentro del Bulto general cerrado: entrega bloqueada, retiro, revalidación y entrega", async () => {
  const db = await setup()
  try {
    for (const orderId of [1031, 1032]) { await prepare(db, orderId); await identify(db, orderId, "printed") }
    const bundle = await newBatch(db, [1031, 1032])
    await verify(db, bundle.id, "BX-PREP-2031", "camera")
    await verify(db, bundle.id, "BX-PREP-2032", "camera")
    await db.query("select close_dispatch_batch($1,$2)", [bundle.id, actor])
    await cancel(db, 1032)
    await assert.rejects(db.query("select confirm_dispatch_batch_handover($1,$2,$3)", [bundle.id, bundle.code, actor]), /DISPATCH_ORDER_BLOCKED/, "entrega bloqueada")

    await db.query("select resolve_cancelled_order_preparation($1,$2,$3,$4)", ["BX-PREP-2032", actor, key(), 1032])
    assert.equal((await db.query<{ r: number; s: string }>("select verification_round r, status s from dispatch_batches where id=$1", [bundle.id])).rows[0].r, 2, "la composición cambió: nueva ronda")
    assert.equal(await count(db, "select count(*)::int n from dispatch_batch_events where batch_id=$1 and action='revalidation_required'", [bundle.id]), 1)
    await assert.rejects(db.query("select confirm_dispatch_batch_handover($1,$2,$3)", [bundle.id, bundle.code, actor]), /DISPATCH_ORDERS_UNVERIFIED/, "hay que volver a validar")
    await assert.rejects(verify(db, bundle.id, "BX-PREP-2032", "scanner"), /DISPATCH_VERIFY_NOT_EXPECTED/, "el retirado ya no es esperado")
    const revalidated = await verify(db, bundle.id, "BX-PREP-2031", "scanner")
    assert.deepEqual([revalidated.duplicate, revalidated.verified, revalidated.expected], [false, 1, 1])
    assert.equal(await count(db, "select count(*)::int n from dispatch_batch_events where batch_id=$1 and action='order_verified' and order_id=1031", [bundle.id]), 2, "historial de ambas rondas")
    await db.query("select confirm_dispatch_batch_handover($1,$2,$3)", [bundle.id, bundle.code, actor])
    assert.equal(await count(db, "select count(*)::int n from ordenes where id=1031 and andreani_handed_over_batch_id=$1", [bundle.id]), 1)
    assert.equal(await count(db, "select count(*)::int n from ordenes where id=1032 and andreani_handed_over_at is not null"), 0)
  } finally { await db.close() }
})

// Histórico anterior a 20261016150000. Los lotes cerrados/entregados sin
// escaneos existen (circuito de 20261005, sin etiquetas BX-PKG): se simulan
// con el estado que dejó aquel cierre.
async function legacyFixture() {
  const db = await setup({ withBundleMigration: false })
  await db.exec("insert into ordenes(id) values (1034),(1035); insert into orden_items(id,orden_id,producto_id,variante_id,cantidad) values (5,1034,1,12,1),(6,1035,1,12,1);")
  CODES[1034] = ["BAR-A-BLUE"]; CODES[1035] = ["BAR-A-BLUE"]
  for (const orderId of [1031, 1032, 1033, 1034, 1035]) await prepare(db, orderId, orderId === 1031 ? 2 : 1)
  const batch = async () => (await db.query<{ id: number; code: string }>("select (create_dispatch_batch($1,$2)).*", [actor, key()])).rows[0]
  // Cerrado con escaneos BX-PKG reales.
  const scanned = await batch()
  for (const code of ["BX-PKG-2031-01", "BX-PKG-2031-02"]) await db.query("select scan_dispatch_parcel($1,$2,$3,$4)", [scanned.id, code, actor, key()])
  await db.query("select close_dispatch_batch($1,$2)", [scanned.id, actor])
  // Cerrado y entregado sin ningún escaneo.
  const closedNoScans = await batch()
  await db.query("select add_order_to_dispatch_batch($1,$2,$3)", [closedNoScans.id, 1032, actor])
  const handedNoScans = await batch()
  await db.query("select add_order_to_dispatch_batch($1,$2,$3)", [handedNoScans.id, 1033, actor])
  await db.query("update dispatch_batches set status='closed', closed_at=now(), closed_by=$2 where id = any($1)", [[closedNoScans.id, handedNoScans.id], actor])
  await db.query("update dispatch_batches set status='handed_over', handed_over_at=now(), handed_over_by=$2 where id=$1", [handedNoScans.id, actor])
  // Abierto: uno completo por BX-PKG y otro sin escanear.
  const open = await batch()
  await db.query("select scan_dispatch_parcel($1,$2,$3,$4)", [open.id, "BX-PKG-2034-01", actor, key()])
  await db.query("select add_order_to_dispatch_batch($1,$2,$3)", [open.id, 1035, actor])
  await db.exec(read(BUNDLE_MIGRATION))
  return { db, scanned, closedNoScans, handedNoScans, open }
}

type LegacyRow = { order_id: number; verified_at: string | null; verified_by: string | null; verification_method: string | null; verification_code: string | null }
const legacyRows = async (db: PGlite) => (await db.query<LegacyRow>(
  "select order_id,verified_at,verified_by,verification_method,verification_code from dispatch_batch_items order by order_id")).rows
const required = async (db: PGlite, batchId: number) => (await db.query<{ r: boolean }>("select verification_required r from dispatch_batches where id=$1", [batchId])).rows[0].r

test("histórico: sólo los escaneos BX-PKG reales cuentan como verificación legacy", async () => {
  const { db } = await legacyFixture()
  try {
    const rows = new Map((await legacyRows(db)).map((row) => [row.order_id, row]))
    const scannedRow = rows.get(1031)!
    assert.deepEqual([scannedRow.verification_method, scannedRow.verification_code, scannedRow.verified_by], ["legacy_parcels", "BX-PKG-2031-01,BX-PKG-2031-02", actor], "con escaneos: verificado con sus etiquetas reales")
    assert.ok(scannedRow.verified_at)
    assert.equal(rows.get(1034)!.verification_method, "legacy_parcels", "abierto con todos sus BX-PKG escaneados")
    for (const orderId of [1032, 1033, 1035]) {
      const row = rows.get(orderId)!
      assert.deepEqual([row.verified_at, row.verified_by, row.verification_method, row.verification_code], [null, null, null, null], `BX-${1000 + orderId}: sin evidencia no se marca verificado`)
    }
    assert.equal(await count(db, "select count(*)::int n from dispatch_batch_items where verification_code = 'BX-PKG'"), 0, "nunca un código genérico")
  } finally { await db.close() }
})

test("histórico cerrado y entregado sin escaneos: compatibles y legibles, sin bloqueo artificial ni verificación inventada", async () => {
  const { db, scanned, closedNoScans, handedNoScans } = await legacyFixture()
  try {
    assert.deepEqual([await required(db, scanned.id), await required(db, closedNoScans.id), await required(db, handedNoScans.id)], [false, false, false])
    const handed = (await db.query<{ status: string; order_id: number; verification_method: string | null }>(
      "select b.status, i.order_id, i.verification_method from dispatch_batches b join dispatch_batch_items i on i.batch_id=b.id where b.id=$1", [handedNoScans.id])).rows
    assert.deepEqual(handed.map((row) => [row.status, row.order_id, row.verification_method]), [["handed_over", 1033, null]], "entregado: se lee tal cual, sin verificación")
    assert.equal((await db.query<{ r: { duplicate: boolean } }>("select confirm_dispatch_batch_handover($1,$2,$3) r", [handedNoScans.id, handedNoScans.code, actor])).rows[0].r.duplicate, true, "entregado sigue siendo entregado")
    // Cerrado sin escaneos: la entrega no se bloquea por la regla nueva...
    await db.query("select confirm_dispatch_batch_handover($1,$2,$3)", [closedNoScans.id, closedNoScans.code, actor])
    assert.equal(await count(db, "select count(*)::int n from ordenes where id=1032 and andreani_handed_over_batch_id=$1", [closedNoScans.id]), 1)
    // ...y el pedido sigue sin figurar como verificado.
    assert.equal(await count(db, "select count(*)::int n from dispatch_batch_items where order_id=1032 and verified_at is null"), 1)
    assert.equal(await count(db, "select count(*)::int n from dispatch_batch_items where order_id=1032 and verified_at is not null"), 0)
  } finally { await db.close() }
})

test("histórico cerrado al que se le retira un pedido: vuelve a exigir BX-PREP antes de entregar", async () => {
  const db = await setup({ withBundleMigration: false })
  try {
    await prepare(db, 1032); await prepare(db, 1033)
    const lot = (await db.query<{ id: number; code: string }>("select (create_dispatch_batch($1,$2)).*", [actor, key()])).rows[0]
    for (const orderId of [1032, 1033]) await db.query("select add_order_to_dispatch_batch($1,$2,$3)", [lot.id, orderId, actor])
    await db.query("update dispatch_batches set status='closed', closed_at=now(), closed_by=$2 where id=$1", [lot.id, actor])
    await db.exec(read(BUNDLE_MIGRATION))
    await db.query("select remove_order_from_dispatch_batch($1,$2,$3,$4)", [lot.id, 1033, actor, "Retirado por control interno"])
    assert.equal(await required(db, lot.id), true, "la composición cambió")
    await assert.rejects(db.query("select confirm_dispatch_batch_handover($1,$2,$3)", [lot.id, lot.code, actor]), /DISPATCH_ORDERS_UNVERIFIED/)
    assert.equal((await verify(db, lot.id, "BX-PREP-2032", "scanner")).verified, 1)
    await db.query("select confirm_dispatch_batch_handover($1,$2,$3)", [lot.id, lot.code, actor])
  } finally { await db.close() }
})

test("lotes abiertos (históricos sin evidencia) y nuevos siguen exigiendo BX-PREP para cerrar y entregar", async () => {
  const { db, open } = await legacyFixture()
  try {
    assert.equal(await required(db, open.id), true)
    await assert.rejects(db.query("select close_dispatch_batch($1,$2)", [open.id, actor]), /DISPATCH_ORDERS_UNVERIFIED/, "falta BX-1035")
    await assert.rejects(verify(db, open.id, "BX-PKG-2035-01", "scanner"), /DISPATCH_VERIFY_PARCEL_CODE/, "un BX-PKG ya no verifica")
    await identify(db, 1035, "printed")
    assert.equal((await verify(db, open.id, "BX-PREP-2035", "scanner")).verified, 2)
    await db.query("select close_dispatch_batch($1,$2)", [open.id, actor])
    await db.query("select confirm_dispatch_batch_handover($1,$2,$3)", [open.id, open.code, actor])

    // Lote nuevo después de la migración.
    await db.exec("insert into ordenes(id) values (1036); insert into orden_items(id,orden_id,producto_id,variante_id,cantidad) values (7,1036,1,12,1);")
    CODES[1036] = ["BAR-A-BLUE"]
    await prepare(db, 1036); await identify(db, 1036, "manual")
    const fresh = await newBatch(db, [1036])
    assert.equal(await required(db, fresh.id), true)
    await assert.rejects(db.query("select close_dispatch_batch($1,$2)", [fresh.id, actor]), /DISPATCH_ORDERS_UNVERIFIED/)
    await assert.rejects(db.query("select confirm_dispatch_batch_handover($1,$2,$3)", [fresh.id, fresh.code, actor]), /DISPATCH_BATCH_NOT_CLOSED/)
    await verify(db, fresh.id, "BX-PREP-2036", "camera")
    await db.query("select close_dispatch_batch($1,$2)", [fresh.id, actor])
    await db.query("select confirm_dispatch_batch_handover($1,$2,$3)", [fresh.id, fresh.code, actor])
  } finally { await db.close() }
})

test("RPC nuevas: sólo service_role con operador verificado", async () => {
  const db = await setup()
  try {
    const access = (await db.query<{ identify: boolean; verify: boolean }>(`select
      has_function_privilege('authenticated','public.confirm_order_physical_identification(bigint,text,text,uuid,uuid)','EXECUTE') identify,
      has_function_privilege('authenticated','public.verify_dispatch_batch_order(bigint,text,text,uuid,uuid,bigint)','EXECUTE') verify`)).rows[0]
    assert.deepEqual(access, { identify: false, verify: false })
    await prepare(db, 1031)
    await db.query("select set_config('request.jwt.claim.role','authenticated',false)")
    await assert.rejects(identify(db, 1031, "manual"), /DISPATCH_FORBIDDEN/)
  } finally { await db.close() }
})
