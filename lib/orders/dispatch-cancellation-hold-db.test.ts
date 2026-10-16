import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

// Flujo completo de Despachos contra las migraciones reales: pickeo por
// código, pedido preparado, lote, cierre, entrega por escaneo y las dos
// cancelaciones posteriores al armado (fuera y dentro de un lote) con el
// ledger de inventario real (inventory_movements + refresh_inventory_stock).

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8")
const actor = "20000000-0000-4000-8000-000000000002"
const adminActor = "20000000-0000-4000-8000-000000000009"
let requestNumber = 0
const key = () => `60000000-0000-4000-8000-${String(++requestNumber).padStart(12, "0")}`

const DISPATCH_HOLD_SETUP = [
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
// Saldo a favor vigente: reverse_customer_credit_for_order (20261014120000) y
// la restitución por NC autorizada con su reparto (20261014130000), tal cual.
const between = (file: string, start: string, end: string) => {
  const text = read(file)
  const from = text.indexOf(start)
  const to = text.indexOf(end, from)
  assert.ok(from >= 0 && to > from, `recorte de ${file}`)
  return text.slice(from, to)
}
const CREDIT_SQL = [
  between("supabase/migrations/20261014120000_customer_credit_reversal_after_credit_note.sql", "CREATE OR REPLACE FUNCTION public.reverse_customer_credit_for_order", "revoke execute on function public.reverse_customer_credit_for_order"),
  between("supabase/migrations/20261014130000_credit_note_fiscal_vs_money_split.sql", "create or replace function public.restore_customer_credit_after_credit_note()", "-- begin_partial_credit_note:"),
]

async function setup() {
  const db = new PGlite()
  for (const file of DISPATCH_HOLD_SETUP) {
    await db.exec(read(file))
    if (file.endsWith("dispatch-inventory-schema.sql")) for (const sql of CREDIT_SQL) await db.exec(sql)
  }
  await db.query("select set_config('request.jwt.claim.role','service_role',false)")
  await db.query("insert into profiles(id,rol) values ($1,'operador')", [actor])
  await db.exec(`
    insert into productos(id,sku,codigo_barra,nombre) values (1,'SKU-A','BAR-A','Auriculares Pro'),(2,'SKU-B','BAR-B','Ñandú lámpara');
    insert into producto_variantes(id,producto_id,sku,codigo_barra,nombre) values (11,1,'SKU-A-RED','BAR-A-RED','Rojo'),(12,1,'SKU-A-BLUE','BAR-A-BLUE','Azul');
    insert into catalog_sku_registry(normalized_sku,product_id,variant_id) values ('SKU-A',1,null),('SKU-B',2,null),('SKU-A-RED',null,11),('SKU-A-BLUE',null,12);
    insert into product_cost_entries(product_id,variant_id,received_quantity) values (1,11,2),(1,12,5),(2,null,1);
    insert into ordenes(id) values (1031),(1032);
    insert into orden_items(id,orden_id,producto_id,variante_id,cantidad) values (1,1031,1,11,2),(2,1031,2,null,1),(3,1032,1,12,1);
  `)
  await db.exec("select refresh_inventory_stock(1); select refresh_inventory_stock(2);")
  return db
}

type ScanResult = { scanned: number; expected: number; status: string; duplicate: boolean }
const scan = async (db: PGlite, orderId: number, code: string, requestKey = key()) =>
  (await db.query<{ r: ScanResult }>("select scan_order_preparation_code($1,$2,$3,$4) r", [orderId, code, actor, requestKey])).rows[0].r
const count = async (db: PGlite, sql: string, params: unknown[] = []) => (await db.query<{ n: number }>(sql, params)).rows[0].n
const stock = async (db: PGlite) => {
  const variants = (await db.query<{ id: number; stock: number }>("select id, stock from producto_variantes order by id")).rows
  const lamp = (await db.query<{ stock: number }>("select stock from productos where id=2")).rows[0].stock
  return { red: Number(variants[0].stock), blue: Number(variants[1].stock), lamp: Number(lamp) }
}
const cancel = (db: PGlite, orderId: number) => db.query(
  "update ordenes set estado='cancelado',cancelled_at=now(),financial_status='refund_pending',cancellation_requested_at=now(),refund_pending_at=now() where id=$1",
  [orderId])
type Resolution = { orderId: number; units: number; batchId: number | null; duplicate: boolean; alreadyResolved: boolean }
const resolve = async (db: PGlite, code: string, requestKey = key(), expected: number | null = null) =>
  (await db.query<{ r: Resolution }>("select resolve_cancelled_order_preparation($1,$2,$3,$4) r", [code, actor, requestKey, expected])).rows[0].r
const claimed = async (db: PGlite) => (await db.query<{ id: number }>("select id from claim_auto_cancellation('5 minutes')")).rows.map((row) => Number(row.id))
// NC automática del worker (identidad NULL): el primer paso de runAutomaticCancellationBatch.
const workerCreditNote = (db: PGlite, orderId: number) => db.query(
  "select begin_partial_credit_note($1::bigint,null::bigint,'external_refund','Cancelación de pedido antes del despacho',10000::numeric,0::numeric,10000::numeric,1,1::bigint,null::uuid,'[]'::jsonb,'cancelacion_antes_despacho','{}'::uuid[])",
  [orderId])
const manualOnly = async (db: PGlite, orderId: number) => {
  assert.deepEqual(await claimed(db), [], "el worker no lo toma")
  await assert.rejects(workerCreditNote(db, orderId), /AUTO_CREDIT_NOTE_MANUAL_REQUIRED/, "ni NC automática")
  assert.equal((await db.query<{ p: boolean }>("select order_was_prepared_for_dispatch($1) p", [orderId])).rows[0].p, true, "corte de preparación: reintegro sólo manual")
  assert.equal((await db.query<{ p: boolean }>("select order_cancelled_after_picking($1) p", [orderId])).rows[0].p, true, "marca durable")
}

async function prepare(db: PGlite, orderId: number, codes: string[], parcels: number | null = null) {
  await db.query("select begin_order_preparation($1,$2)", [orderId, actor])
  for (const code of codes) await scan(db, orderId, code)
  if (parcels) await db.query("select set_order_package_parcels($1,$2,$3,$4)", [orderId, parcels, actor, key()])
}

test("A-E: pickeo por código, unidades múltiples, código inválido, doble lectura y pedido preparado", async () => {
  const db = await setup()
  try {
    assert.deepEqual(await stock(db), { red: 0, blue: 4, lamp: 0 }, "el stock ya bajó al confirmarse el pago")
    await db.query("select begin_order_preparation($1,$2)", [1031, actor])
    await assert.rejects(scan(db, 1031, "NO-EXISTE-999"), /DISPATCH_CODE_UNKNOWN/)
    await assert.rejects(scan(db, 1031, "BAR-A-BLUE"), /DISPATCH_WRONG_SKU_OR_VARIANT/)
    const repeated = key()
    assert.equal((await scan(db, 1031, "BAR-A-RED", repeated)).scanned, 1)
    const retry = await scan(db, 1031, "BAR-A-RED", repeated)
    assert.deepEqual([retry.scanned, retry.duplicate], [1, true], "la misma lectura no suma otra unidad")
    assert.equal((await scan(db, 1031, "sku-a-red")).scanned, 2)
    await assert.rejects(scan(db, 1031, "BAR-A-RED"), /DISPATCH_QUANTITY_EXCEEDED/)
    assert.equal((await scan(db, 1031, "BAR-B")).status, "prepared")
    assert.equal(await count(db, "select count(*)::int n from order_audit_events where order_id=1031 and action='order_prepared'"), 1)
    assert.equal((await db.query<{ c: string }>("select order_preparation_barcode(1031,1) c")).rows[0].c, "BX-PREP-2031")
    assert.deepEqual(await stock(db), { red: 0, blue: 4, lamp: 0 }, "pickear no vuelve a descontar")
  } finally { await db.close() }
})

test("F (0 unidades): armado iniciado sin ningún pickeo sigue el circuito automático", async () => {
  const db = await setup()
  try {
    await db.query("select begin_order_preparation($1,$2)", [1031, actor])
    await cancel(db, 1031)
    assert.equal(await count(db, "select count(*)::int n from order_cancellation_holds"), 0)
    assert.deepEqual(await stock(db), { red: 2, blue: 4, lamp: 1 }, "el stock vuelve con la cancelación, como hoy")
    await assert.rejects(scan(db, 1031, "BAR-A-RED"), /DISPATCH_ORDER_BLOCKED/, "un cancelado no puede empezar a pickearse")
    assert.deepEqual(await claimed(db), [1031], "el worker lo toma como siempre")
  } finally { await db.close() }
})

test("1/N: con UNA unidad pickeada ya retiene stock y reintegro; se resuelve identificando el pedido", async () => {
  const db = await setup()
  try {
    await db.query("select begin_order_preparation($1,$2)", [1031, actor])
    await scan(db, 1031, "BAR-A-RED")
    await cancel(db, 1031)
    const hold = (await db.query<{ units: number; picked_units: number; prepared: boolean }>("select units,picked_units,prepared from order_cancellation_holds where order_id=1031 and resolved_at is null")).rows[0]
    assert.deepEqual([hold.units, hold.picked_units, hold.prepared], [3, 1, false])
    assert.equal(await count(db, "select count(*)::int n from order_audit_events where order_id=1031 and action='dispatch_cancellation_hold_created' and previous_status='packing'"), 1)
    assert.deepEqual(await stock(db), { red: 0, blue: 4, lamp: 0 }, "no vuelve nada solo")
    assert.deepEqual(await claimed(db), [], "el worker no lo toma")
    await assert.rejects(db.exec("insert into mercadopago_order_refunds(order_id,status) values (1031,'processing')"), /DISPATCH_PHYSICAL_RESOLUTION_REQUIRED/)
    await assert.rejects(db.exec("update ordenes set financial_status='refunded' where id=1031"), /DISPATCH_PHYSICAL_RESOLUTION_REQUIRED/, "ningún camino lo da por reintegrado")
    // Pickeo parcial: no hay etiquetas impresas; el número de pedido lo identifica.
    const done = await resolve(db, "BX-2031", key(), 1031)
    assert.deepEqual([done.units, done.alreadyResolved], [3, false])
    assert.deepEqual(await stock(db), { red: 2, blue: 4, lamp: 1 }, "el stock sí vuelve aunque el reintegro siga manual")
    await manualOnly(db, 1031)
    assert.equal(await count(db, "select count(*)::int n from order_cancellation_holds where order_id=1031 and resolved_at is null"), 0)
  } finally { await db.close() }
})

test("N/N: armado completo exige una etiqueta (BX-PREP o bulto), no sólo el número de pedido", async () => {
  const db = await setup()
  try {
    await prepare(db, 1031, ["BAR-A-RED", "BAR-A-RED", "BAR-B"])
    await cancel(db, 1031)
    const hold = (await db.query<{ picked_units: number; prepared: boolean }>("select picked_units,prepared from order_cancellation_holds where order_id=1031")).rows[0]
    assert.deepEqual([hold.picked_units, hold.prepared], [3, true])
    await assert.rejects(resolve(db, "BX-2031"), /DISPATCH_RESOLUTION_LABEL_REQUIRED/)
    assert.equal((await resolve(db, "BX-PREP-2031")).units, 3)
    assert.deepEqual(await stock(db), { red: 2, blue: 4, lamp: 1 })
    await manualOnly(db, 1031)
  } finally { await db.close() }
})

test("saldo a favor, pickeo y SIN obligación fiscal: el retiro físico devuelve stock pero nunca saldo; sólo Admin lo libera, una vez", async () => {
  const db = await setup()
  try {
    const customer = "40000000-0000-4000-8000-000000000004"
    // Sin obligación fiscal (ni encolada ni facturada): sólo la retención difiere el saldo.
    await db.query("update ordenes set usuario_id=$1, credit_balance_used=3000, invoice_queued_at=null, invoice_cae=null, invoice_status=null where id=1031", [customer])
    await db.query("select begin_order_preparation($1,$2)", [1031, actor])
    await scan(db, 1031, "BAR-B")
    await cancel(db, 1031)
    // Mismo orden que admin_cancel_order: cancela y después intenta restituir el saldo.
    const deferred = (await db.query<{ restored_amount: number }>("select restored_amount from reverse_customer_credit_for_order(1031)")).rows[0]
    assert.equal(Number(deferred.restored_amount), 0, "retención activa: el saldo no se restaura")
    assert.equal(await count(db, "select count(*)::int n from customer_credit_movements"), 0)
    assert.equal(await count(db, "select count(*)::int n from order_audit_events where order_id=1031 and action='customer_credit_reversal_deferred'"), 1)
    const first = key()
    await resolve(db, "BX-2031", first)
    await resolve(db, "BX-2031", first)
    await resolve(db, "BX-2031")
    assert.deepEqual(await stock(db), { red: 2, blue: 4, lamp: 1 }, "el stock sí vuelve")
    // Ni la resolución ni una llamada directa (cualquier cancelación la invoca) devuelven el saldo.
    await db.query("select * from reverse_customer_credit_for_order(1031)")
    assert.equal(await count(db, "select count(*)::int n from customer_credit_movements"), 0, "saldo: nada automático")
    const order = (await db.query<{ credit_balance_used: number; financial_status: string }>("select credit_balance_used,financial_status from ordenes where id=1031")).rows[0]
    assert.deepEqual([Number(order.credit_balance_used), order.financial_status], [3000, "refund_pending"], "ni se marca reintegrado")

    // Sólo una acción explícita de Admin lo libera, una vez.
    await assert.rejects(db.query("select * from release_cancelled_order_customer_credit(1031,$1)", [actor]), /FINANCIAL_FORBIDDEN/, "un operador no puede")
    await db.query("insert into profiles(id,rol) values ($1,'admin')", [adminActor])
    const released = (await db.query<{ restored_amount: number }>("select restored_amount from release_cancelled_order_customer_credit(1031,$1)", [adminActor])).rows[0]
    assert.equal(Number(released.restored_amount), 3000)
    await db.query("select * from release_cancelled_order_customer_credit(1031,$1)", [adminActor])
    const movements = (await db.query<{ amount: number }>("select amount from customer_credit_movements where order_id=1031")).rows
    assert.deepEqual(movements.map((row) => Number(row.amount)), [3000], "restitución exactamente una vez")
    assert.equal(await count(db, "select count(*)::int n from order_audit_events where order_id=1031 and action='customer_credit_released_by_admin'"), 2)
  } finally { await db.close() }
})

test("saldo a favor con pickeo y venta facturada: ni el retiro ni la liberación directa lo devuelven; vuelve con la NC del Admin", async () => {
  const db = await setup()
  try {
    const customer = "40000000-0000-4000-8000-000000000006"
    await db.query("update ordenes set usuario_id=$1, credit_balance_used=3000 where id=1031", [customer])
    await db.query("insert into profiles(id,rol) values ($1,'admin')", [adminActor])
    await db.query("select begin_order_preparation($1,$2)", [1031, actor])
    await scan(db, 1031, "BAR-B")
    await cancel(db, 1031)
    await resolve(db, "BX-2031")
    await db.query("select * from reverse_customer_credit_for_order(1031)")
    assert.equal(await count(db, "select count(*)::int n from customer_credit_movements"), 0)
    await assert.rejects(db.query("select * from release_cancelled_order_customer_credit(1031,$1)", [adminActor]), /CREDIT_NOTE_REQUIRED_BEFORE_REFUND/, "con factura, sólo por NC")
    await db.exec("insert into order_credit_notes(order_id,status,external_amount,customer_credit_amount,created_by) values (1031,'authorized',7000,3000,'" + adminActor + "')")
    const movements = (await db.query<{ amount: number }>("select amount from customer_credit_movements where order_id=1031")).rows
    assert.deepEqual(movements.map((row) => Number(row.amount)), [3000])
  } finally { await db.close() }
})

test("pago combinado (saldo + Mercado Pago) con pickeo parcial: nada se mueve hasta el retiro; después, reparto intacto", async () => {
  const db = await setup()
  try {
    const customer = "40000000-0000-4000-8000-000000000005"
    await db.query("update ordenes set usuario_id=$1, credit_balance_used=3000, payment_confirmed_amount=7000, total=10000 where id=1031", [customer])
    await db.query("select begin_order_preparation($1,$2)", [1031, actor])
    await scan(db, 1031, "BAR-A-RED")
    await cancel(db, 1031)
    await db.query("select * from reverse_customer_credit_for_order(1031)")
    assert.equal(await count(db, "select count(*)::int n from customer_credit_movements"), 0, "saldo: nada")
    await assert.rejects(db.exec("insert into mercadopago_order_refunds(order_id,status) values (1031,'requested')"), /DISPATCH_PHYSICAL_RESOLUTION_REQUIRED/, "Mercado Pago: nada")
    await assert.rejects(db.exec("insert into order_credit_notes(order_id,status,external_amount,customer_credit_amount) values (1031,'processing',7000,3000)"), /DISPATCH_PHYSICAL_RESOLUTION_REQUIRED/, "NC: nada")
    assert.deepEqual(await claimed(db), [])

    await resolve(db, "BX-2031")
    // Venta facturada: el saldo sigue esperando la NC (regla fiscal de siempre),
    // y la NC/reintegro ya no los hace el worker: los emite Admin.
    assert.equal(await count(db, "select count(*)::int n from customer_credit_movements"), 0)
    await manualOnly(db, 1031)
    await db.exec("insert into order_credit_notes(order_id,status,external_amount,customer_credit_amount) values (1031,'processing',7000,3000)")
    await db.exec("update order_credit_notes set status='authorized' where order_id=1031")
    await db.exec("update order_credit_notes set status='authorized' where order_id=1031")
    const movements = (await db.query<{ amount: number }>("select amount from customer_credit_movements where order_id=1031")).rows
    assert.deepEqual(movements.map((row) => Number(row.amount)), [3000], "saldo: su parte, una vez (NC emitida por Admin)")
  } finally { await db.close() }
})

test("lote cerrado: retenido no entra al worker; retirado por escaneo sigue requiriendo reintegro manual", async () => {
  const db = await setup()
  try {
    await prepare(db, 1032, ["BAR-A-BLUE"], 1)
    const lot = (await db.query<{ id: number }>("select (create_dispatch_batch($1,$2)).id", [actor, key()])).rows[0]
    await db.query("select scan_dispatch_parcel($1,$2,$3,$4)", [lot.id, "BX-PKG-2032-01", actor, key()])
    await db.query("select close_dispatch_batch($1,$2)", [lot.id, actor])
    await cancel(db, 1032)
    assert.equal(await count(db, "select count(*)::int n from order_cancellation_holds where order_id=1032 and batch_id=$1", [lot.id]), 1)
    assert.equal((await db.query<{ p: boolean }>("select order_was_prepared_for_dispatch(1032) p")).rows[0].p, true)
    assert.deepEqual(await claimed(db), [], "nunca intenta NC/refund para fallar")
    await resolve(db, "BX-PKG-2032-01")
    assert.equal(await count(db, "select count(*)::int n from dispatch_batch_items where order_id=1032 and removed_at is null"), 0)
    assert.equal((await stock(db)).blue, 5, "el stock vuelve")
    await manualOnly(db, 1032)
  } finally { await db.close() }
})

test("lote cerrado con retiro manual previo: sigue siendo sólo reintegro manual (el worker no lo toma)", async () => {
  const db = await setup()
  try {
    await prepare(db, 1032, ["BAR-A-BLUE"], 1)
    const lot = (await db.query<{ id: number }>("select (create_dispatch_batch($1,$2)).id", [actor, key()])).rows[0]
    await db.query("select scan_dispatch_parcel($1,$2,$3,$4)", [lot.id, "BX-PKG-2032-01", actor, key()])
    await db.query("select close_dispatch_batch($1,$2)", [lot.id, actor])
    await db.query("select remove_order_from_dispatch_batch($1,$2,$3,$4)", [lot.id, 1032, actor, "Retirado por control interno"])
    await cancel(db, 1032)
    await resolve(db, "BX-PKG-2032-01")
    assert.equal((await db.query<{ p: boolean }>("select order_was_prepared_for_dispatch(1032) p")).rows[0].p, true)
    assert.deepEqual(await claimed(db), [])
  } finally { await db.close() }
})

test("G-J, W: cancelado ya preparado retiene stock y reintegro hasta escanear el pedido, una sola vez", async () => {
  const db = await setup()
  try {
    await prepare(db, 1031, ["BAR-A-RED", "BAR-A-RED", "BAR-B"])
    await cancel(db, 1031)
    const hold = (await db.query<{ units: number; batch_id: number | null; attempt_number: number }>("select units,batch_id,attempt_number from order_cancellation_holds where order_id=1031 and resolved_at is null")).rows[0]
    assert.deepEqual([hold.units, hold.batch_id, hold.attempt_number], [3, null, 1])
    assert.equal(await count(db, "select count(*)::int n from order_audit_events where order_id=1031 and action='dispatch_cancellation_hold_created' and new_status='requires_physical_resolution'"), 1)
    assert.deepEqual(await stock(db), { red: 0, blue: 4, lamp: 0 }, "H: el stock NO vuelve solo")

    // W: ningún camino fiscal/financiero arranca antes del retiro físico.
    assert.deepEqual(await claimed(db), [], "el worker no toma el pedido")
    for (const sql of [
      "insert into order_credit_notes(order_id) values (1031)",
      "insert into mercadopago_order_refunds(order_id,status) values (1031,'processing')",
      "insert into order_financial_resolutions(order_id,choice) values (1031,'manual_refund')",
      "insert into order_refund_proofs(order_id) values (1031)",
    ]) await assert.rejects(db.exec(sql), /DISPATCH_PHYSICAL_RESOLUTION_REQUIRED/, sql)
    await assert.rejects(db.query("select reset_order_preparation($1,$2,$3,$4)", [1031, actor, key(), "Rearmar el pedido cancelado"]), /DISPATCH_CANCELLATION_HOLD_ACTIVE/)

    // I: sólo el código del pedido preparado (o de un bulto) lo resuelve.
    await assert.rejects(resolve(db, "BAR-A-RED"), /DISPATCH_RESOLUTION_CODE_IS_PRODUCT/)
    await assert.rejects(resolve(db, "BX-PREP-2032"), /DISPATCH_RESOLUTION_NOT_REQUIRED/)
    await assert.rejects(resolve(db, "BX-PREP-2031", key(), 1032), /DISPATCH_RESOLUTION_WRONG_ORDER/)
    await assert.rejects(resolve(db, "BX-PREP-2031-R2"), /DISPATCH_PARCEL_STALE/)
    await assert.rejects(resolve(db, "ZZZ"), /DISPATCH_CODE_UNKNOWN/)
    const first = key()
    const done = await resolve(db, " bx-prep-2031 ", first)
    assert.deepEqual([done.orderId, done.units, done.duplicate, done.alreadyResolved], [1031, 3, false, false])
    assert.deepEqual(await stock(db), { red: 2, blue: 4, lamp: 1 }, "vuelven exactamente las 3 unidades (2 iguales + 1 distinta)")

    // J: doble clic y segundo dispositivo: sin efectos nuevos.
    assert.equal((await resolve(db, "BX-PREP-2031", first)).duplicate, true)
    assert.equal((await resolve(db, "BX-PREP-2031")).alreadyResolved, true)
    assert.deepEqual(await stock(db), { red: 2, blue: 4, lamp: 1 })
    assert.equal(await count(db, "select count(*)::int n from order_audit_events where order_id=1031 and action='dispatch_cancellation_stock_restored'"), 1)
    assert.equal(await count(db, "select count(*)::int n from order_audit_events where order_id=1031 and action='dispatch_cancellation_physically_resolved'"), 1)

    // Resuelto: el circuito fiscal sigue, pero sólo por Admin (reintegro manual).
    await manualOnly(db, 1031)
    await db.exec("insert into order_credit_notes(order_id) values (1031)")
  } finally { await db.close() }
})

test("K-T: lote con pedido cancelado adentro, retiro por escaneo, cierre y entrega a Andreani por código", async () => {
  const db = await setup()
  try {
    await prepare(db, 1031, ["BAR-A-RED", "BAR-A-RED", "BAR-B"], 2)
    await prepare(db, 1032, ["BAR-A-BLUE"], 1)
    const lot = (await db.query<{ id: number; code: string }>("select (create_dispatch_batch($1,$2)).*", [actor, key()])).rows[0]
    const scanParcel = async (code: string) => (await db.query<{ r: { orderId: number; scannedCount: number; duplicate: boolean } }>("select scan_dispatch_parcel($1,$2,$3,$4) r", [lot.id, code, actor, key()])).rows[0].r
    const added = await scanParcel("BX-PKG-2031-01")
    assert.deepEqual([added.orderId, added.scannedCount, added.duplicate], [1031, 1, false], "K: el escaneo agrega el pedido al lote")
    const again = await scanParcel("BX-PKG-2031-01")
    assert.deepEqual([again.scannedCount, again.duplicate], [1, true], "L: repetido no duplica")
    assert.equal(await count(db, "select count(*)::int n from dispatch_batch_items where batch_id=$1 and removed_at is null", [lot.id]), 1)
    await scanParcel("BX-PKG-2031-02")
    await scanParcel("BX-PKG-2032-01")

    await cancel(db, 1032)
    assert.equal(await count(db, "select count(*)::int n from order_cancellation_holds where order_id=1032 and batch_id=$1 and resolved_at is null", [lot.id]), 1, "M")
    await assert.rejects(db.query("select close_dispatch_batch($1,$2)", [lot.id, actor]), /DISPATCH_ORDER_BLOCKED/, "N: el lote no cierra")
    await assert.rejects(db.query("select confirm_dispatch_batch_handover($1,$2,$3)", [lot.id, lot.code, actor]), /DISPATCH_BATCH_NOT_CLOSED/)
    assert.equal((await stock(db)).blue, 4)

    const removed = await resolve(db, "BX-PKG-2032-01", key(), 1032)
    assert.deepEqual([removed.orderId, removed.batchId, removed.units], [1032, lot.id, 1], "O: el escaneo del bulto lo retira")
    assert.equal(await count(db, "select count(*)::int n from dispatch_batch_items where batch_id=$1 and order_id=1032 and removed_at is not null and removal_reason like 'Pedido cancelado%'", [lot.id]), 1)
    assert.equal((await stock(db)).blue, 5)

    await db.query("select close_dispatch_batch($1,$2)", [lot.id, actor])
    await db.query("select close_dispatch_batch($1,$2)", [lot.id, actor])
    assert.equal(await count(db, "select count(*)::int n from dispatch_batch_events where batch_id=$1 and action='closed'", [lot.id]), 1, "P/Q: cierre idempotente")

    await assert.rejects(db.query("select confirm_dispatch_batch_handover($1,$2,$3)", [lot.id, "DSP-20000101-001", actor]), /DISPATCH_HANDOVER_CODE_MISMATCH/, "R: sólo el código de ESTE lote")
    const handed = (await db.query<{ r: { duplicate: boolean } }>("select confirm_dispatch_batch_handover($1,$2,$3) r", [lot.id, ` ${lot.code.toLowerCase()} `, actor])).rows[0].r
    assert.equal(handed.duplicate, false, "S")
    assert.equal(await count(db, "select count(*)::int n from ordenes where id=1031 and andreani_handed_over_batch_id=$1", [lot.id]), 1)
    const twice = (await db.query<{ r: { duplicate: boolean } }>("select confirm_dispatch_batch_handover($1,$2,$3) r", [lot.id, lot.code, actor])).rows[0].r
    assert.equal(twice.duplicate, true, "T: doble escaneo de entrega")
    assert.equal(await count(db, "select count(*)::int n from order_audit_events where order_id=1031 and action='order_handed_over_to_andreani'"), 1)
    assert.equal(await count(db, "select count(*)::int n from ordenes where id=1032 and andreani_handed_over_at is not null"), 0)
  } finally { await db.close() }
})

test("retención y resolución: sin acceso para clientes y sin reutilizar prefijos reservados", async () => {
  const db = await setup()
  try {
    const access = (await db.query<{ rls: boolean; write: boolean; resolve: boolean; handover: boolean }>(`
      select c.relrowsecurity rls,
        has_table_privilege('authenticated','public.order_cancellation_holds','INSERT') write,
        has_function_privilege('authenticated','public.resolve_cancelled_order_preparation(text,uuid,uuid,bigint)','EXECUTE') resolve,
        has_function_privilege('authenticated','public.confirm_dispatch_batch_handover(bigint,text,uuid)','EXECUTE') handover
      from pg_class c where c.oid='public.order_cancellation_holds'::regclass`)).rows[0]
    assert.deepEqual(access, { rls: true, write: false, resolve: false, handover: false })
    await assert.rejects(db.exec("update producto_variantes set codigo_barra='BX-PREP-2031' where id=12"), /reserved_check/)
    // El catálogo público (anon) lee una vista que consulta la retención: la
    // función tiene que poder ejecutarse con el rol del visitante.
    await db.exec("insert into inventory_return_movements(product_id,variant_id,discounted_quantity,conditioned_active,conditioned_name,conditioned_sku,conditioned_color_hex) values (1,11,2,true,'Auriculares reacondicionados','SKU-A-COND','#112233')")
    await db.exec("set role anon")
    const publicCatalog = await db.query<{ available_quantity: number }>("select available_quantity from conditioned_catalog_variants")
    await db.exec("reset role")
    assert.deepEqual(publicCatalog.rows.map((row) => Number(row.available_quantity)), [2])
    await db.query("select set_config('request.jwt.claim.role','authenticated',false)")
    await assert.rejects(resolve(db, "BX-PREP-2031"), /DISPATCH_FORBIDDEN/)
  } finally { await db.close() }
})
