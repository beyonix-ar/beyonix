import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

// Despachos con la etiqueta Andreani como identificación (20261016160000),
// diferencias de pickeo auditadas y compatibilidad con BX-PREP, contra las
// migraciones reales.

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8")
const actor = "20000000-0000-4000-8000-000000000002"
const superAdmin = "20000000-0000-4000-8000-000000000003"
let requestNumber = 0
const key = () => `81000000-0000-4000-8000-${String(++requestNumber).padStart(12, "0")}`

const MIGRATIONS = [
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
  "supabase/migrations/20261016150000_dispatch_general_bundle_verification.sql",
  "supabase/migrations/20261016160000_dispatch_andreani_identification.sql",
  "supabase/migrations/20261017100000_dispatch_finalize_on_verification.sql",
  "supabase/migrations/20261017110000_super_admin_force_cancellation.sql",
]

async function setup() {
  const db = new PGlite()
  for (const file of MIGRATIONS) {
    await db.exec(read(file))
    // Columnas reales de producción que el fixture compartido no declara.
    if (file.endsWith("dispatch-schema.sql")) await db.exec(`
      alter table ordenes add column andreani_tracking text;
      alter table ordenes add column credit_note_required boolean default false;
      alter table ordenes add column invoice_number integer;
      alter table ordenes add column invoice_point integer;
      alter table ordenes add column cancellation_requested_by uuid;
      alter table orden_items add column precio numeric default 1000;
    `)
    if (file.endsWith("dispatch-inventory-schema.sql")) await db.exec("alter table order_credit_notes add column total_amount numeric default 0;")
  }
  await db.query("select set_config('request.jwt.claim.role','service_role',false)")
  await db.query("insert into profiles(id,rol) values ($1,'operador')", [actor])
  await db.exec(`
    insert into productos(id,sku,codigo_barra,nombre) values (1,'SKU-A','BAR-A','Auriculares Pro'),(2,'SKU-B','BAR-B','Ñandú lámpara');
    insert into producto_variantes(id,producto_id,sku,codigo_barra,nombre) values (11,1,'SKU-A-RED','BAR-A-RED','Rojo'),(12,1,'SKU-A-BLUE','BAR-A-BLUE','Azul');
    insert into catalog_sku_registry(normalized_sku,product_id,variant_id) values ('SKU-A',1,null),('SKU-B',2,null),('SKU-A-RED',null,11),('SKU-A-BLUE',null,12);
    insert into product_cost_entries(product_id,variant_id,received_quantity) values (1,11,5),(1,12,5),(2,null,3);
    insert into ordenes(id,andreani_envio_id,andreani_tracking,andreani_bulto_numbers) values
      (1031,'ENV-1031','360000001031','{360000001031,360000001031-02}'),
      (1032,'ENV-1032','360000001032','{360000001032}'),
      (1033,'ENV-1033','360000001033','{360000001033}');
    insert into orden_items(id,orden_id,producto_id,variante_id,cantidad,precio) values
      (1,1031,1,11,3,12500.50),(2,1031,2,null,1,8000),(3,1032,1,12,1,9000),(4,1033,1,12,1,9000);
  `)
  await db.exec("select refresh_inventory_stock(1); select refresh_inventory_stock(2);")
  return db
}

const CODES: Record<number, string[]> = { 1031: ["BAR-A-RED", "BAR-A-RED", "BAR-A-RED", "BAR-B"], 1032: ["BAR-A-BLUE"], 1033: ["BAR-A-BLUE"] }
const scan = (db: PGlite, orderId: number, code: string) => db.query("select scan_order_preparation_code($1,$2,$3,$4)", [orderId, code, actor, key()])
async function pick(db: PGlite, orderId: number, codes = CODES[orderId]) {
  await db.query("select begin_order_preparation($1,$2)", [orderId, actor])
  for (const code of codes) await scan(db, orderId, code)
}
const printLabel = (db: PGlite, orderId: number) =>
  db.query<{ m: string | null }>("select (confirm_order_andreani_label($1,$2)).identification_method m", [orderId, actor])
async function ready(db: PGlite, orderId: number) { await pick(db, orderId); await printLabel(db, orderId) }

type Adjust = { quantity_before: number; quantity_after: number; unit_price: string; difference_amount: string; settlement: string; actor_id: string }
const adjust = async (db: PGlite, orderId: number, itemId: number, quantity: number, options: { problem?: string; settlement?: string; agreement?: string; requestKey?: string } = {}) =>
  (await db.query<Adjust>("select (r).* from (select adjust_order_preparation_line($1,$2,$3,$4,$5,$6,$7,$8) r) s", [
    orderId, itemId, quantity, options.problem ?? "stock_shortage", options.settlement ?? "manual_refund",
    options.agreement ?? "Cliente acepta 2 unidades y reintegro manual del resto", actor, options.requestKey ?? key(),
  ])).rows[0]

const newBatch = async (db: PGlite, orderIds: number[]) =>
  (await db.query<{ id: number; code: string }>("select (create_dispatch_batch_with_orders($1,$2,$3)).*", [actor, key(), orderIds])).rows[0]
type Verify = { orderId: number; code: string; method: string; duplicate: boolean; expected: number; verified: number }
const verify = async (db: PGlite, batchId: number, code: string | null, method: string, requestKey = key(), orderId: number | null = null) =>
  (await db.query<{ r: Verify }>("select verify_dispatch_batch_order($1,$2,$3,$4,$5,$6) r", [batchId, code, method, actor, requestKey, orderId])).rows[0].r
const verifyAndFinalize = async (db: PGlite, batchId: number, code: string, requestKey = key()) =>
  (await db.query<{ r: Verify & { finalized: boolean } }>("select verify_and_finalize_dispatch_batch($1,$2,'scanner',$3,$4,null) r", [batchId, code, actor, requestKey])).rows[0].r
const count = async (db: PGlite, sql: string, params: unknown[] = []) => (await db.query<{ n: number }>(sql, params)).rows[0].n
const reasons = async (db: PGlite, orderId: number) => (await db.query<{ r: string[] }>("select dispatch_order_block_reasons($1) r", [orderId])).rows[0].r
const cancel = (db: PGlite, orderId: number) => db.query(
  "update ordenes set estado='cancelado',cancelled_at=now(),financial_status='refund_pending',cancellation_requested_at=now(),refund_pending_at=now() where id=$1",
  [orderId])

test("Super Admin cancela de inmediato un pedido facturado dentro de Bulto; conserva stock y audita pendientes", async () => {
  const db = await setup()
  try {
    await db.query("insert into profiles(id,rol) values ($1,'super_admin')", [superAdmin])
    await ready(db, 1032)
    const batch = await newBatch(db, [1032])
    const stockBefore = (await db.query<{ stock: number }>("select stock from producto_variantes where id=12")).rows[0].stock
    await db.query("select set_config('request.jwt.claim.role','authenticated',false)")
    await assert.rejects(db.query("select super_admin_cancel_order($1,$2,$3,$4)", [1032, superAdmin, "solicitud_cliente", "Solicitud del cliente confirmada"]), /FORBIDDEN/)
    await db.query("select set_config('request.jwt.claim.role','service_role',false)")
    await assert.rejects(db.query("select super_admin_cancel_order($1,$2,$3,$4)", [1032, actor, "solicitud_cliente", "Solicitud del cliente confirmada"]), /SUPER_ADMIN_REQUIRED/)
    await assert.rejects(db.query("select super_admin_cancel_order($1,$2,$3,$4)", [1032, superAdmin, "solicitud_cliente", "corto"]), /CANCELLATION_REASON_REQUIRED/)
    const order = (await db.query<{ estado: string; financial_status: string; credit_note_required: boolean }>("select (r).estado,(r).financial_status,(r).credit_note_required from (select super_admin_cancel_order($1,$2,$3,$4) r) s", [1032, superAdmin, "solicitud_cliente", "Solicitud del cliente confirmada"])).rows[0]
    assert.deepEqual(order, { estado: "cancelado", financial_status: "refund_pending", credit_note_required: true })
    await assert.rejects(db.query("select super_admin_cancel_order($1,$2,$3,$4)", [1032, superAdmin, "solicitud_cliente", "Solicitud del cliente confirmada"]), /ORDER_ALREADY_CANCELLED/)
    assert.equal(await count(db, "select count(*)::int n from order_audit_events where order_id=1032 and action='order_force_cancelled_by_super_admin'"), 1)
    assert.equal((await db.query<{ manual: boolean }>("select auto_cancellation_next_attempt_at='infinity'::timestamptz manual from ordenes where id=1032")).rows[0].manual, true)
    assert.equal(await count(db, "select count(*)::int n from order_cancellation_holds where order_id=1032 and resolved_at is null"), 1)
    assert.equal((await db.query<{ stock: number }>("select stock from producto_variantes where id=12")).rows[0].stock, stockBefore)
    const audit = (await db.query<{ actor_id: string; previous_status: string; new_status: string; metadata: { batchId: number; stock: { physicalHoldId: number }; fiscal: { resolution: string }; financial: { refundResolution: string } } }>("select actor_id,previous_status,new_status,metadata from order_audit_events where order_id=1032 and action='order_force_cancelled_by_super_admin'")).rows[0]
    assert.equal(audit.actor_id, superAdmin)
    assert.equal(audit.previous_status, "pagado")
    assert.equal(audit.new_status, "cancelado")
    assert.equal(audit.metadata.batchId, batch.id)
    assert.ok(audit.metadata.stock.physicalHoldId)
    assert.equal(audit.metadata.fiscal.resolution, "pending")
    assert.equal(audit.metadata.financial.refundResolution, "pending")
    await db.query("select resolve_cancelled_order_preparation($1,$2,$3,$4)", ["360000001032", actor, key(), 1032])
    assert.equal(await count(db, "select count(*)::int n from dispatch_batch_items where batch_id=$1 and order_id=1032 and removed_at is null", [batch.id]), 0)
    assert.equal(await count(db, "select count(*)::int n from order_cancellation_holds where order_id=1032 and resolved_at is null"), 0)
    assert.equal((await db.query<{ stock: number }>("select stock from producto_variantes where id=12")).rows[0].stock, stockBefore + 1)
    const pending = (await db.query<{ financial_status: string; credit_note_required: boolean }>("select financial_status,credit_note_required from ordenes where id=1032")).rows[0]
    assert.deepEqual(pending, { financial_status: "refund_pending", credit_note_required: true })
  } finally { await db.close() }
})

test("Super Admin cancela un Bulto finalizado y un pedido entregado sin liberar stock despachado", async () => {
  const db = await setup()
  try {
    await db.query("insert into profiles(id,rol) values ($1,'super_admin')", [superAdmin])
    for (const orderId of [1032, 1033]) await ready(db, orderId)
    const batch = await newBatch(db, [1032])
    await verifyAndFinalize(db, batch.id, "360000001032")
    await db.query("select super_admin_cancel_order($1,$2,$3,$4)", [1032, superAdmin, "error_administrativo", "Pedido cancelado dentro del Bulto finalizado"])
    assert.equal(await count(db, "select count(*)::int n from order_cancellation_holds where order_id=1032 and batch_id=$1 and resolved_at is null", [batch.id]), 1)

    const deliveredBatch = await newBatch(db, [1033])
    await verifyAndFinalize(db, deliveredBatch.id, "360000001033")
    await db.query("select confirm_dispatch_batch_handover($1,$2,$3)", [deliveredBatch.id, deliveredBatch.code, actor])
    await db.query("update ordenes set estado='entregado' where id=1033")
    const stockBefore = (await db.query<{ stock: number }>("select stock from producto_variantes where id=12")).rows[0].stock
    await db.query("select super_admin_cancel_order($1,$2,$3,$4)", [1033, superAdmin, "solicitud_cliente", "Cancelación posterior a la entrega confirmada"])
    const delivered = (await db.query<{ estado: string; financial_status: string; retained: boolean }>("select estado,financial_status,super_admin_stock_retained_at is not null retained from ordenes where id=1033")).rows[0]
    assert.deepEqual(delivered, { estado: "cancelado", financial_status: "refund_pending", retained: true })
    assert.equal((await db.query<{ stock: number }>("select stock from producto_variantes where id=12")).rows[0].stock, stockBefore)
    assert.equal(await count(db, "select count(*)::int n from order_cancellation_holds where order_id=1033"), 0)
  } finally { await db.close() }
})

test("Super Admin cancela sin pago y durante conciliación Andreani; no inventa reintegro", async () => {
  const db = await setup()
  try {
    await db.query("insert into profiles(id,rol) values ($1,'super_admin')", [superAdmin])
    await db.query(`update ordenes set estado='pendiente',payment_status='pendiente',paid_at=null,
      payment_confirmed_amount=0,financial_status='pending_payment',invoice_status='pending',invoice_cae=null,
      andreani_creation_status='reconciliation_required' where id=1032`)
    await db.query("select super_admin_cancel_order($1,$2,$3,$4)", [1032, superAdmin, "error_administrativo", "Cancelar antes de recibir pago confirmado"])
    const order = (await db.query<{ estado: string; financial_status: string; credit_note_required: boolean; refund_pending_at: string | null }>("select estado,financial_status,credit_note_required,refund_pending_at from ordenes where id=1032")).rows[0]
    assert.deepEqual(order, { estado: "cancelado", financial_status: "cancelled", credit_note_required: false, refund_pending_at: null })
    assert.equal(await count(db, "select count(*)::int n from order_audit_events where order_id=1032 and action='order_force_cancelled_by_super_admin' and metadata->'andreani'->>'creationStatus'='reconciliation_required'"), 1)
    await db.query("update ordenes set invoice_status='pending',invoice_cae=null,andreani_creation_status='claimed' where id=1033")
    await db.query("select super_admin_cancel_order($1,$2,$3,$4)", [1033, superAdmin, "solicitud_cliente", "Cancelar pedido pagado sin factura emitida"])
    const paid = (await db.query<{ financial_status: string; credit_note_required: boolean }>("select financial_status,credit_note_required from ordenes where id=1033")).rows[0]
    assert.deepEqual(paid, { financial_status: "refund_pending", credit_note_required: false })
  } finally { await db.close() }
})

test("Super Admin conserva una Nota de Crédito ya autorizada y un reintegro completado", async () => {
  const db = await setup()
  try {
    await db.query("insert into profiles(id,rol) values ($1,'super_admin')", [superAdmin])
    await db.query("insert into order_credit_notes(order_id,status,total_amount) values (1033,'authorized',10000)")
    await db.query("update ordenes set financial_status='refunded' where id=1033")
    await db.query("select super_admin_cancel_order($1,$2,$3,$4)", [1033, superAdmin, "error_administrativo", "Cancelación excepcional después de reintegro"])
    const order = (await db.query<{ estado: string; financial_status: string; credit_note_required: boolean }>("select estado,financial_status,credit_note_required from ordenes where id=1033")).rows[0]
    assert.deepEqual(order, { estado: "cancelado", financial_status: "refunded", credit_note_required: false })
  } finally { await db.close() }
})

test("la última etiqueta Andreani finaliza el Bulto sin entrega ni DSP; reintento idempotente", async () => {
  const db = await setup()
  try {
    await ready(db, 1032)
    await ready(db, 1033)
    const batch = await newBatch(db, [1032, 1033])
    const first = await verifyAndFinalize(db, batch.id, "360000001032")
    assert.deepEqual([first.verified, first.expected, first.finalized], [1, 2, false])
    assert.equal((await db.query<{ status: string }>("select status from dispatch_batches where id=$1", [batch.id])).rows[0].status, "open")
    const requestKey = key()
    const last = await verifyAndFinalize(db, batch.id, "360000001033", requestKey)
    assert.deepEqual([last.verified, last.expected, last.finalized], [2, 2, true])
    assert.equal((await verifyAndFinalize(db, batch.id, "360000001033", requestKey)).duplicate, true)
    const row = (await db.query<{ status: string; handed_over_at: string | null }>("select status,handed_over_at from dispatch_batches where id=$1", [batch.id])).rows[0]
    assert.deepEqual(row, { status: "closed", handed_over_at: null })
    assert.equal(await count(db, "select count(*)::int n from dispatch_batch_events where batch_id=$1 and action='closed'", [batch.id]), 1)
    assert.equal(await count(db, "select count(*)::int n from ordenes where id in (1032,1033) and andreani_handed_over_at is not null"), 0)
  } finally { await db.close() }
})

test("reabrir exige Super Admin y motivo; registra la intervención y pide nuevo control", async () => {
  const db = await setup()
  const superAdmin = "20000000-0000-4000-8000-000000000003"
  try {
    await db.query("insert into profiles(id,rol) values ($1,'super_admin')", [superAdmin])
    await ready(db, 1032)
    const batch = await newBatch(db, [1032])
    await verifyAndFinalize(db, batch.id, "360000001032")
    await assert.rejects(db.query("select reopen_dispatch_batch($1,$2,$3)", [batch.id, actor, "Control físico repetido"]), /DISPATCH_FORBIDDEN/)
    await assert.rejects(db.query("select reopen_dispatch_batch($1,$2,$3)", [batch.id, superAdmin, "corto"]), /DISPATCH_REASON_REQUIRED/)
    await db.query("select reopen_dispatch_batch($1,$2,$3)", [batch.id, superAdmin, "Control físico repetido por diferencia"])
    const reopened = (await db.query<{ status: string; verification_round: number }>("select status,verification_round from dispatch_batches where id=$1", [batch.id])).rows[0]
    assert.deepEqual(reopened, { status: "open", verification_round: 2 })
    assert.equal(await count(db, "select count(*)::int n from dispatch_batch_events where batch_id=$1 and action='reopened' and actor_id=$2 and metadata->>'reason'='Control físico repetido por diferencia'", [batch.id, superAdmin]), 1)
    assert.equal((await verifyAndFinalize(db, batch.id, "360000001032")).finalized, true)
  } finally { await db.close() }
})

test("faltante resuelto por un operador: cantidad, diferencia, acuerdo y auditoría", async () => {
  const db = await setup()
  try {
    await pick(db, 1031, ["BAR-A-RED", "BAR-A-RED", "BAR-B"])
    assert.equal((await db.query<{ s: string }>("select status s from order_packages where order_id=1031")).rows[0].s, "preparing", "2 de 3: incompleto")
    await assert.rejects(printLabel(db, 1031), /DISPATCH_PACKAGE_NOT_PREPARED/, "incompleto: sin etiqueta Andreani")

    await assert.rejects(adjust(db, 1031, 1, 1), /DISPATCH_ADJUSTMENT_BELOW_PICKED/, "no se puede bajar de lo ya pickeado")
    await assert.rejects(adjust(db, 1031, 1, 3), /DISPATCH_ADJUSTMENT_INVALID/, "tiene que reducir")
    await assert.rejects(adjust(db, 1031, 1, 2, { agreement: "corto" }), /DISPATCH_ADJUSTMENT_AGREEMENT_REQUIRED/)
    await assert.rejects(adjust(db, 1031, 1, 2, { problem: "forzar" }), /DISPATCH_ADJUSTMENT_INVALID/)
    await assert.rejects(adjust(db, 1031, 1, 2, { settlement: "auto_refund" }), /DISPATCH_ADJUSTMENT_INVALID/)

    const requestKey = key()
    const adjusted = await adjust(db, 1031, 1, 2, { requestKey })
    assert.deepEqual([adjusted.quantity_before, adjusted.quantity_after, Number(adjusted.unit_price), Number(adjusted.difference_amount), adjusted.settlement, adjusted.actor_id],
      [3, 2, 12500.5, 12500.5, "manual_refund", actor], "diferencia calculada en la base con el precio del renglón")
    assert.equal(Number((await adjust(db, 1031, 1, 2, { requestKey })).difference_amount), 12500.5, "mismo request_key: idempotente")
    await assert.rejects(adjust(db, 1031, 1, 1, { requestKey }), /DISPATCH_SCAN_KEY_CONFLICT/)
    assert.equal(await count(db, "select count(*)::int n from order_preparation_adjustments where order_id=1031"), 1)

    const pkg = (await db.query<{ status: string; prepared_by: string }>("select status,prepared_by from order_packages where order_id=1031")).rows[0]
    assert.deepEqual([pkg.status, pkg.prepared_by], ["prepared", actor], "con la diferencia el pedido queda completo")
    const audit = (await db.query<{ metadata: Record<string, unknown> }>("select metadata from order_audit_events where order_id=1031 and action='order_preparation_adjusted'")).rows
    assert.equal(audit.length, 1)
    assert.deepEqual([audit[0].metadata.quantityBefore, audit[0].metadata.quantityAfter, audit[0].metadata.problem, audit[0].metadata.financial],
      [3, 2, "stock_shortage", "manual_settlement_pending"])
    assert.equal(await count(db, "select count(*)::int n from order_audit_events where order_id=1031 and action='order_prepared'"), 1)
    assert.ok(!(await reasons(db, 1031)).includes("items_changed"), "una diferencia registrada no es un cambio de artículos")
    assert.equal(Number((await db.query<{ c: number }>("select cantidad c from orden_items where id=1")).rows[0].c), 3, "lo vendido no se toca: el reintegro es manual")
    await assert.rejects(adjust(db, 1031, 2, 0), /DISPATCH_ADJUSTMENT_NOT_PICKING/, "después del pickeo no hay ajustes")
  } finally { await db.close() }
})

test("diferencias: renglón en cero sí, pedido vacío no; rearmar vuelve a lo vendido", async () => {
  const db = await setup()
  try {
    await pick(db, 1031, ["BAR-A-RED"])
    await adjust(db, 1031, 2, 0, { problem: "damaged", settlement: "customer_credit", agreement: "Lámpara dañada: saldo a favor acordado" })
    await assert.rejects(adjust(db, 1031, 1, 0), /DISPATCH_ADJUSTMENT_BELOW_PICKED/)
    await adjust(db, 1031, 1, 1, { problem: "quantity_reduction", settlement: "no_difference", agreement: "Cliente pidió sólo una unidad, sin diferencia" })
    assert.equal((await db.query<{ s: string }>("select status s from order_packages where order_id=1031")).rows[0].s, "prepared")

    const empty = await setup()
    try {
      await empty.query("select begin_order_preparation($1,$2)", [1032, actor])
      await assert.rejects(adjust(empty, 1032, 3, 0), /DISPATCH_ADJUSTMENT_EMPTY_ORDER/, "un pedido sin unidades es una cancelación")
    } finally { await empty.close() }

    await db.query("select reset_order_preparation($1,$2,$3,$4)", [1031, actor, key(), "Rearmado por control de calidad"])
    const lines = (await db.query<{ order_item_id: number; expected_quantity: number }>("select order_item_id,expected_quantity from order_preparation_lines order by order_item_id")).rows
    assert.deepEqual(lines.filter((line) => line.order_item_id <= 2).map((line) => line.expected_quantity), [3, 1], "nuevo intento: vuelve a lo vendido")
    assert.ok(!(await reasons(db, 1031)).includes("items_changed"))
  } finally { await db.close() }
})

test("etiqueta Andreani: exige envío creado, identifica el pedido y reimprimir no cambia nada", async () => {
  const db = await setup()
  try {
    await db.query("update ordenes set andreani_envio_id=null, andreani_creation_status=null where id=1032")
    await pick(db, 1032)
    await assert.rejects(printLabel(db, 1032), /DISPATCH_SHIPMENT_PENDING/, "sin envío Andreani no hay etiqueta")
    const empty = (await db.query<{ id: number }>("select (create_dispatch_batch($1,$2)).id", [actor, key()])).rows[0]
    await assert.rejects(db.query("select add_order_to_dispatch_batch($1,$2,$3)", [empty.id, 1032, actor]), /DISPATCH_IDENTIFICATION_PENDING/)

    await db.query("update ordenes set andreani_envio_id='ENV-1032', andreani_creation_status='created' where id=1032")
    assert.equal((await printLabel(db, 1032)).rows[0].m, "andreani")
    assert.equal((await printLabel(db, 1032)).rows[0].m, "andreani", "reimprimir")
    assert.equal(await count(db, "select count(*)::int n from order_audit_events where order_id=1032 and action='order_andreani_label_printed'"), 1)
    // Sin BX-PKG medidos: el envío Andreani ya define los bultos.
    await db.query("select add_order_to_dispatch_batch($1,$2,$3)", [empty.id, 1032, actor])
    assert.equal(await count(db, "select count(*)::int n from dispatch_batch_items where order_id=1032 and removed_at is null"), 1)
  } finally { await db.close() }
})

test("Bulto general verificado con la etiqueta Andreani: lector, cámara, pegado, manual y duplicados", async () => {
  const db = await setup()
  try {
    for (const orderId of [1031, 1032, 1033]) await ready(db, orderId)
    const bundle = await newBatch(db, [1031, 1032])
    const other = await newBatch(db, [1033])
    await assert.rejects(db.query("select close_dispatch_batch($1,$2)", [bundle.id, actor]), /DISPATCH_ORDERS_UNVERIFIED/, "cierre bloqueado con faltantes")

    for (const [code, error] of [
      ["360000001033", /DISPATCH_PREP_OTHER_BATCH/],
      ["999999999999", /DISPATCH_CODE_UNKNOWN/],
      ["BAR-A-RED", /DISPATCH_CODE_IS_PRODUCT/],
      ["BX-2031", /DISPATCH_VERIFY_LABEL_REQUIRED/],
      ["BX-PKG-2031-01", /DISPATCH_VERIFY_PARCEL_CODE/],
      [bundle.code, /DISPATCH_CODE_IS_BATCH/],
    ] as const) await assert.rejects(verify(db, bundle.id, code, "scanner"), error, code)

    const scannerKey = key()
    const first = await verify(db, bundle.id, "360000001031", "scanner", scannerKey)
    assert.deepEqual([first.orderId, first.code, first.duplicate, first.verified, first.expected], [1031, "360000001031", false, 1, 2])
    assert.equal((await verify(db, bundle.id, "360000001031", "scanner", scannerKey)).duplicate, true, "doble lectura: misma clave")
    const secondParcel = await verify(db, bundle.id, "360000001031-02", "camera")
    assert.deepEqual([secondParcel.duplicate, secondParcel.verified], [true, 1], "otro bulto del mismo pedido no suma")
    assert.equal(await count(db, "select count(*)::int n from dispatch_batch_events where batch_id=$1 and action='order_verified'", [bundle.id]), 1)

    const pasted = await verify(db, bundle.id, "  env-1032\t", "manual_code")
    assert.deepEqual([pasted.orderId, pasted.code, pasted.verified], [1032, "ENV-1032", 2], "pegado/tipeado con espacios y minúsculas")
    await db.query("select close_dispatch_batch($1,$2)", [bundle.id, actor])

    const manual = await verify(db, other.id, null, "manual_selection", key(), 1033)
    assert.deepEqual([manual.code, manual.method], ["360000001033", "manual_selection"], "la confirmación manual registra el seguimiento")
    const handed = (await db.query<{ r: { duplicate: boolean } }>("select confirm_dispatch_batch_handover($1,$2,$3) r", [bundle.id, bundle.code.toLowerCase(), actor])).rows[0].r
    assert.equal(handed.duplicate, false)
    assert.equal(await count(db, "select count(*)::int n from ordenes where id in (1031,1032) and andreani_handed_over_batch_id=$1", [bundle.id]), 2)

    await db.query("update ordenes set andreani_tracking='360000001032' where id=1033")
    await assert.rejects(verify(db, other.id, "360000001032", "scanner"), /DISPATCH_ANDREANI_CODE_AMBIGUOUS/, "dos pedidos con el mismo código: no se adivina")
  } finally { await db.close() }
})

test("compatibilidad: un pedido identificado con BX-PREP sigue verificándose con su BX-PREP", async () => {
  const db = await setup()
  try {
    await pick(db, 1032)
    await db.query("select confirm_order_physical_identification($1,$2,'printed',$3,$4)", [1032, "BX-PREP-2032", actor, key()])
    const bundle = await newBatch(db, [1032])
    assert.equal((await verify(db, bundle.id, "BX-PREP-2032", "scanner")).verified, 1)
  } finally { await db.close() }
})

test("filtro 2: cancelado dentro del Bulto general se retira escaneando su etiqueta Andreani y se revalida", async () => {
  const db = await setup()
  try {
    for (const orderId of [1031, 1032]) await ready(db, orderId)
    const bundle = await newBatch(db, [1031, 1032])
    await verify(db, bundle.id, "360000001031", "scanner")
    await verify(db, bundle.id, "360000001032", "scanner")
    await db.query("select close_dispatch_batch($1,$2)", [bundle.id, actor])
    await cancel(db, 1032)
    await assert.rejects(db.query("select confirm_dispatch_batch_handover($1,$2,$3)", [bundle.id, bundle.code, actor]), /DISPATCH_ORDER_BLOCKED/, "entrega bloqueada")
    await assert.rejects(db.query("select resolve_cancelled_order_preparation($1,$2,$3,$4)", ["360000001031", actor, key(), 1032]), /DISPATCH_RESOLUTION_WRONG_ORDER/)
    await db.query("select resolve_cancelled_order_preparation($1,$2,$3,$4)", [" 360000001032 ", actor, key(), 1032])
    assert.equal(await count(db, "select count(*)::int n from dispatch_batch_items where batch_id=$1 and removed_at is null", [bundle.id]), 1)
    await assert.rejects(db.query("select confirm_dispatch_batch_handover($1,$2,$3)", [bundle.id, bundle.code, actor]), /DISPATCH_ORDERS_UNVERIFIED/, "revalidar")
    await verify(db, bundle.id, "360000001031", "camera")
    await db.query("select confirm_dispatch_batch_handover($1,$2,$3)", [bundle.id, bundle.code, actor])
  } finally { await db.close() }
})

test("filtro 1: cancelado con pickeo parcial retiene stock aunque todavía no haya etiqueta Andreani", async () => {
  const db = await setup()
  try {
    await db.query("update ordenes set andreani_envio_id=null, andreani_creation_status=null where id=1031")
    await pick(db, 1031, ["BAR-A-RED"])
    await cancel(db, 1031)
    assert.equal(await count(db, "select count(*)::int n from order_cancellation_holds where order_id=1031 and resolved_at is null and not prepared"), 1)
    await db.query("select resolve_cancelled_order_preparation($1,$2,$3,$4)", ["BX-2031", actor, key(), 1031])
    assert.equal(await count(db, "select count(*)::int n from order_cancellation_holds where order_id=1031 and resolved_at is not null"), 1)
  } finally { await db.close() }
})

test("cancelado con pickeo completo: sin etiqueta todavía se retira con su número; con envío exige la etiqueta Andreani", async () => {
  const db = await setup()
  try {
    await db.query("update ordenes set andreani_envio_id=null, andreani_creation_status=null where id=1032")
    await pick(db, 1032)
    await cancel(db, 1032)
    await db.query("select resolve_cancelled_order_preparation($1,$2,$3,$4)", ["BX-2032", actor, key(), 1032])
    assert.equal(await count(db, "select count(*)::int n from order_cancellation_holds where order_id=1032 and resolved_at is not null"), 1)

    await pick(db, 1033)
    await cancel(db, 1033)
    await assert.rejects(db.query("select resolve_cancelled_order_preparation($1,$2,$3,$4)", ["BX-2033", actor, key(), 1033]), /DISPATCH_RESOLUTION_LABEL_REQUIRED/, "tiene etiqueta Andreani: hay que escanearla")
    await db.query("select resolve_cancelled_order_preparation($1,$2,$3,$4)", ["ENV-1033", actor, key(), 1033])
  } finally { await db.close() }
})

test("RPC y tabla nuevas: sólo service_role con operador verificado", async () => {
  const db = await setup()
  try {
    const access = (await db.query<{ label: boolean; adjust: boolean; lookup: boolean; table: boolean }>(`select
      has_function_privilege('authenticated','public.confirm_order_andreani_label(bigint,uuid)','EXECUTE') label,
      has_function_privilege('authenticated','public.adjust_order_preparation_line(bigint,bigint,integer,text,text,text,uuid,uuid)','EXECUTE') adjust,
      has_function_privilege('anon','public.order_id_from_andreani_code(text)','EXECUTE') lookup,
      has_table_privilege('authenticated','public.order_preparation_adjustments','SELECT') "table"`)).rows[0]
    assert.deepEqual(access, { label: false, adjust: false, lookup: false, table: false })
    await pick(db, 1032)
    await db.query("select set_config('request.jwt.claim.role','authenticated',false)")
    await assert.rejects(printLabel(db, 1032), /DISPATCH_FORBIDDEN/)
  } finally { await db.close() }
})
