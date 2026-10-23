import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

// El QR final del Bulto como único corte de cancelación (20261023100000),
// contra las migraciones reales de Despachos: cancelación del cliente antes
// del pickeo, con pickeo y dentro de un Bulto; validación completa del Bulto
// al confirmar el QR; stock, dinero y avisos una sola vez.

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8")
const actor = "20000000-0000-4000-8000-000000000002"
const adminActor = "20000000-0000-4000-8000-000000000004"
const superAdmin = "20000000-0000-4000-8000-000000000003"
const customer = "10000000-0000-4000-8000-000000000001"
let requestNumber = 0
const key = () => `91000000-0000-4000-8000-${String(++requestNumber).padStart(12, "0")}`

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
  "supabase/migrations/20261016170000_dispatch_batch_display_numbers.sql",
  "supabase/migrations/20261017100000_dispatch_finalize_on_verification.sql",
  "supabase/migrations/20261017110000_super_admin_force_cancellation.sql",
  "supabase/migrations/20261018120000_dispatch_mobile_final_control.sql",
  "supabase/migrations/20261021100000_dispatch_andreani_label_scan_confirmation.sql",
]
const CUTOFF_MIGRATION = "supabase/migrations/20261023100000_bundle_handover_cancellation_cutoff.sql"
const DIRECT_CANCELLATION_MIGRATION = "supabase/migrations/20261023110000_super_admin_cancellation_financial_circuit.sql"
const RETURN_INSPECTION_MIGRATION = "supabase/migrations/20261023120000_return_inspection_money_decision.sql"

const between = (file: string, start: string, end: string) => {
  const text = read(file)
  const from = text.indexOf(start)
  const to = text.indexOf(end, from)
  assert.ok(from >= 0 && to > from, `recorte de ${file}`)
  return text.slice(from, to)
}
// Definiciones vigentes (texto real) de las tres funciones cuyo bloque de
// "despachado" reemplaza la migración: así se prueba el reemplazo exacto.
const REPLACED_FUNCTIONS = [
  between("supabase/migrations/20260916100000_block_cancellation_during_andreani_creation.sql",
    "create or replace function public.approve_order_claim_cancellation(", "revoke all on function public.approve_order_claim_cancellation"),
  between("supabase/migrations/20260916100000_block_cancellation_during_andreani_creation.sql",
    "create or replace function public.admin_cancel_order(", "revoke all on function public.admin_cancel_order"),
  between("supabase/migrations/20261014140000_automatic_cancellation_fiscal_refund.sql",
    "create or replace function public.begin_mercadopago_order_refund(", "revoke all on function public.begin_mercadopago_order_refund"),
]

async function setup() {
  const db = new PGlite()
  for (const file of MIGRATIONS) {
    await db.exec(read(file))
    // Columnas reales de producción que los fixtures compartidos no declaran.
    if (file.endsWith("dispatch-schema.sql")) await db.exec(read("lib/orders/fixtures/bundle-handover-orders.sql"))
    if (file.endsWith("dispatch-inventory-schema.sql")) await db.exec(read("lib/orders/fixtures/bundle-handover-finance.sql"))
  }
  for (const sql of REPLACED_FUNCTIONS) await db.exec(sql)
  await db.exec(read("supabase/migrations/20260917110000_fix_customer_cancellation_type_and_null_bugs.sql"))
  await db.exec(read(CUTOFF_MIGRATION))
  await db.exec(read(DIRECT_CANCELLATION_MIGRATION))
  // Columnas reales que usan las restricciones de ordenes que redefine la inspección.
  await db.exec("alter table ordenes add column if not exists admin_visible_at timestamptz, add column if not exists payment_confirmed_at timestamptz")
  await db.exec(read(RETURN_INSPECTION_MIGRATION))
  // Mismo trigger que producción para el aviso de cancelación.
  await db.exec(`create trigger zz_notify_customer_order_cancelled_trigger after update of estado, financial_status
    on ordenes for each row execute function notify_customer_order_cancelled()`)
  await db.query("select set_config('request.jwt.claim.role','service_role',false)")
  await db.query("insert into profiles(id,rol) values ($1,'operador'),($2,'admin'),($3,'super_admin')", [actor, adminActor, superAdmin])
  await db.exec(`
    insert into productos(id,sku,codigo_barra,nombre) values (1,'SKU-A','BAR-A','Auriculares Pro');
    insert into producto_variantes(id,producto_id,sku,codigo_barra,nombre) values (12,1,'SKU-A-BLUE','BAR-A-BLUE','Azul');
    insert into catalog_sku_registry(normalized_sku,product_id,variant_id) values ('SKU-A',1,null),('SKU-A-BLUE',null,12);
    insert into product_cost_entries(product_id,variant_id,received_quantity) values (1,12,20);
  `)
  for (let id = 1031; id <= 1040; id += 1) {
    await db.query(`insert into ordenes(id,usuario_id,andreani_envio_id,andreani_tracking,andreani_bulto_numbers,payment_id)
      values ($1,$2,$3,$4,$5,$6)`, [id, customer, `ENV-${id}`, `360000${String(id).padStart(6, "0")}`, [`360000${String(id).padStart(6, "0")}`], String(90000 + id)])
    await db.query("insert into orden_items(id,orden_id,producto_id,variante_id,cantidad,precio) values ($1,$1,1,12,1,10000)", [id])
  }
  await db.exec("select refresh_inventory_stock(1)")
  return db
}

const blueStock = async (db: PGlite) => Number((await db.query<{ stock: number }>("select stock from producto_variantes where id=12")).rows[0].stock)
const count = async (db: PGlite, sql: string, params: unknown[] = []) => Number((await db.query<{ n: number }>(sql, params)).rows[0].n)
const customerCancel = (db: PGlite, orderId: number) => db.query<{ r: Record<string, unknown> }>(
  "select request_customer_order_cancellation_with_claim($1,$2,$3) r", [orderId, customer, "Ya no lo necesito, gracias"])
const label = (orderId: number) => `360000${String(orderId).padStart(6, "0")}`
async function ready(db: PGlite, orderId: number) {
  await db.query("select begin_order_preparation($1,$2)", [orderId, actor])
  await db.query("select scan_order_preparation_code($1,$2,$3,$4)", [orderId, "BAR-A-BLUE", actor, key()])
  await db.query("select confirm_order_andreani_label($1,$2,$3)", [orderId, label(orderId), actor])
}
async function closedBundle(db: PGlite, orderIds: number[]) {
  const batch = (await db.query<{ id: number; code: string }>("select (create_dispatch_batch_with_orders($1,$2,$3)).*", [actor, key(), orderIds])).rows[0]
  for (const orderId of orderIds) await db.query("select verify_and_finalize_dispatch_batch($1,$2,'scanner',$3,$4,null)", [batch.id, label(orderId), actor, key()])
  return batch
}
const handover = (db: PGlite, batch: { id: number; code: string }) =>
  db.query<{ r: { duplicate: boolean } }>("select confirm_dispatch_batch_handover($1,$2,$3) r", [batch.id, batch.code, actor])
const resolve = (db: PGlite, orderId: number, requestKey = key()) =>
  db.query<{ r: { units: number; alreadyResolved: boolean; duplicate: boolean } }>(
    "select resolve_cancelled_order_preparation($1,$2,$3,$4) r", [label(orderId), actor, requestKey, orderId])
const audit = async (db: PGlite, orderId: number) =>
  (await db.query<{ metadata: Record<string, unknown> }>("select metadata from order_audit_events where order_id=$1 and actor_type='customer' order by id desc limit 1", [orderId])).rows[0]?.metadata
async function rejection(promise: Promise<unknown>) {
  try { await promise } catch (error) { return error as { message: string; detail?: string; hint?: string } }
  throw new Error("se esperaba un rechazo")
}

test("corte canónico: el QR final corta; el envío Andreani creado con armado no; un envío histórico sin armado sí", async () => {
  const db = await setup()
  try {
    const cutoff = async (sql: string) => (await db.query<{ c: boolean }>(`select order_dispatch_cutoff_reached(o) c from ordenes o where id=1031 ${sql}`)).rows[0].c
    assert.equal(await cutoff(""), true, "envío creado sin pasar por Despachos: no hay forma de saber si salió")
    await ready(db, 1031)
    assert.equal(await cutoff(""), false, "con armado, el envío creado todavía no salió de BEYONIX")
    await db.exec("update ordenes set andreani_estado='En distribución' where id=1031")
    assert.equal(await cutoff(""), true, "estado de transporte real")
    // El reemplazo del bloque de "despachado" quedó aplicado en las tres funciones.
    for (const fn of ["admin_cancel_order", "approve_order_claim_cancellation", "begin_mercadopago_order_refund"]) {
      const definition = (await db.query<{ d: string }>(`select pg_get_functiondef(p.oid) d from pg_proc p where p.proname=$1`, [fn])).rows[0].d
      assert.match(definition, /order_dispatch_cutoff_reached\(v_order\)/, fn)
      assert.doesNotMatch(definition, /andreani_envio_id\), ''\) is not null/, `${fn}: sin el corte por envío creado`)
    }
  } finally { await db.close() }
})

test("A: cancelación antes del picking: stock libre al instante, sin retención, auditada y avisada una vez", async () => {
  const db = await setup()
  try {
    await db.exec("update ordenes set andreani_envio_id=null, andreani_tracking=null, andreani_creation_status=null, andreani_bulto_numbers='{}' where id=1031")
    const before = await blueStock(db)
    const result = (await customerCancel(db, 1031)).rows[0].r
    assert.equal(result.estado, "cancelado")
    assert.equal(result.physical_state, "not_picked")
    assert.equal(await blueStock(db), before + 1, "L: la reserva/venta se libera")
    assert.equal(await count(db, "select count(*)::int n from order_cancellation_holds where order_id=1031"), 0)
    assert.equal((await audit(db, 1031))?.physicalState, "not_picked")
    const notices = (await db.query<{ title: string; body: string }>("select title, body from customer_notifications where order_id=1031")).rows
    assert.deepEqual(notices.map((n) => n.title), ["Cancelación recibida"])
    assert.match(notices[0].body, /Recibimos la cancelación de tu pedido BX-2031/)
    // Reintegro realizado: aviso propio, una vez; la cancelación no se reenvía.
    await db.exec("update ordenes set financial_status='refunded', refund_method='mercadopago' where id=1031")
    await db.exec("update ordenes set financial_status='refunded' where id=1031")
    const titles = (await db.query<{ title: string }>("select title from customer_notifications where order_id=1031 order by id")).rows.map((n) => n.title)
    assert.deepEqual(titles, ["Cancelación recibida", "Reintegro realizado"])
    await assert.rejects(customerCancel(db, 1031), /ORDER_ALREADY_CANCELLED/, "P: reintento no duplica")
    assert.equal(await blueStock(db), before + 1)
  } finally { await db.close() }
})

test("B/K: con picking: retiene stock; la resolución física lo devuelve una sola vez (reintentos sin efecto)", async () => {
  const db = await setup()
  try {
    await ready(db, 1032)
    const before = await blueStock(db)
    const result = (await customerCancel(db, 1032)).rows[0].r
    assert.equal(result.physical_state, "prepared")
    assert.equal(await blueStock(db), before, "la mercadería sigue fuera de estantería")
    assert.equal(await count(db, "select count(*)::int n from order_cancellation_holds where order_id=1032 and resolved_at is null"), 1)
    const notice = (await db.query<{ body: string }>("select body from customer_notifications where order_id=1032")).rows[0]
    assert.match(notice.body, /Estamos procesando tu cancelación/, "S: sin lenguaje técnico")
    const first = key()
    assert.equal((await resolve(db, 1032, first)).rows[0].r.units, 1)
    assert.equal((await resolve(db, 1032, first)).rows[0].r.duplicate, true)
    assert.equal((await resolve(db, 1032)).rows[0].r.alreadyResolved, true)
    assert.equal(await blueStock(db), before + 1, "K: stock devuelto una vez")
    assert.equal(await count(db, "select count(*)::int n from order_audit_events where order_id=1032 and action='dispatch_cancellation_stock_restored'"), 1)
  } finally { await db.close() }
})

test("C-H: Bulto con 5 cancelados: el QR no entrega y lista los 5; retirarlos todos habilita la entrega; después no se cancela", async () => {
  const db = await setup()
  try {
    const cancelled = [1033, 1034, 1035, 1036, 1037]
    const all = [...cancelled, 1038]
    for (const orderId of all) await ready(db, orderId)
    const batch = await closedBundle(db, all)
    const before = await blueStock(db)
    // C: dentro de un Bulto no entregado, la cancelación se permite.
    for (const orderId of cancelled) {
      const result = (await customerCancel(db, orderId)).rows[0].r
      assert.equal(result.physical_state, "in_bundle", `BX-${1000 + orderId}`)
    }
    assert.equal((await audit(db, 1033))?.bundleId, batch.id, "auditoría: Bulto al cancelar")
    assert.equal(await count(db, "select count(*)::int n from order_cancellation_holds where batch_id=$1 and resolved_at is null", [batch.id]), 5)
    assert.equal(await blueStock(db), before, "nada vuelve solo: siguen físicamente en el Bulto")

    // D/E: el QR final valida el Bulto completo y lista TODOS los problemas.
    const error = await rejection(handover(db, batch))
    assert.match(error.message, /DISPATCH_ORDER_BLOCKED/)
    assert.equal(error.hint, "DISPATCH_BATCH_ISSUES")
    const issues = JSON.parse(String(error.detail)) as Array<{ orderId: number; reasons: string[] }>
    assert.deepEqual(issues.map((issue) => issue.orderId), cancelled)
    assert.ok(issues.every((issue) => issue.reasons.includes("cancelled") && issue.reasons.includes("physical_hold")))
    const mobile = await rejection(db.query("select confirm_dispatch_batch_mobile_control($1,$2)", [batch.id, actor]))
    assert.equal(JSON.parse(String(mobile.detail)).length, 5, "el control desde el celular, igual")
    assert.equal((await db.query<{ status: string }>("select status from dispatch_batches where id=$1", [batch.id])).rows[0].status, "closed")
    assert.equal(await count(db, "select count(*)::int n from ordenes where andreani_handed_over_at is not null"), 0, "nada quedó entregado")

    // F: retirar todos (escaneo) devuelve el stock una vez y habilita la entrega.
    for (const orderId of cancelled) await resolve(db, orderId)
    assert.equal(await blueStock(db), before + 5)
    assert.deepEqual((await db.query<{ r: unknown[] }>("select dispatch_batch_handover_issues($1) r", [batch.id])).rows[0].r, [])
    await assert.rejects(handover(db, batch), /DISPATCH_ORDERS_UNVERIFIED/, "la composición cambió: se vuelve a controlar")
    await db.query("select verify_and_finalize_dispatch_batch($1,$2,'scanner',$3,$4,null)", [batch.id, label(1038), actor, key()])

    // G: QR válido -> entregado, con usuario y fecha, una sola vez.
    assert.equal((await handover(db, batch)).rows[0].r.duplicate, false)
    assert.equal((await handover(db, batch)).rows[0].r.duplicate, true, "P: doble lectura")
    const handed = (await db.query<{ by: string; at: string | null }>("select andreani_handed_over_by by, andreani_handed_over_at at from ordenes where id=1038")).rows[0]
    assert.equal(handed.by, actor)
    assert.ok(handed.at)
    assert.equal(await count(db, "select count(*)::int n from order_audit_events where order_id=1038 and action='order_handed_over_to_andreani'"), 1)
    assert.equal(await count(db, "select count(*)::int n from ordenes where andreani_handed_over_at is not null"), 1)

    // H: después del QR final el cliente ya no puede cancelar (ni por API).
    await assert.rejects(customerCancel(db, 1038), /ORDER_ALREADY_DISPATCHED/)
    assert.equal((await db.query<{ estado: string }>("select estado from ordenes where id=1038")).rows[0].estado, "pagado")

    // J: entregado al cliente: tampoco; la postventa sigue por reclamo/devolución.
    await db.exec("update ordenes set estado='entregado' where id=1038")
    await assert.rejects(customerCancel(db, 1038), /ORDER_ALREADY_DISPATCHED/)
  } finally { await db.close() }
})

test("M-O: dinero una sola vez: retención bloquea; después saldo a favor o Mercado Pago por decisión del Admin", async () => {
  const db = await setup()
  try {
    for (const orderId of [1033, 1034]) await ready(db, orderId)
    await closedBundle(db, [1033, 1034])
    await customerCancel(db, 1033)
    await customerCancel(db, 1034)
    const reserve = (orderId: number, choice: string) => db.query<{ id: string; choice: string }>(
      "select (r).id, (r).choice from (select reserve_order_financial_resolution($1,$2,$3) r) s", [orderId, adminActor, choice])
    await assert.rejects(reserve(1033, "beyonix_credit"), /FINANCIAL_PREPARED_MANUAL_ONLY/, "con la mercadería en el Bulto no hay saldo")
    await assert.rejects(reserve(1034, "mercadopago_refund"), /DISPATCH_PHYSICAL_RESOLUTION_REQUIRED/, "ni reintegro")
    await resolve(db, 1033)
    await resolve(db, 1034)
    const credit = (await reserve(1033, "beyonix_credit")).rows[0]
    assert.equal((await reserve(1033, "beyonix_credit")).rows[0].id, credit.id, "O: idempotente")
    await assert.rejects(reserve(1033, "manual_refund"), /FINANCIAL_CHOICE_CONFLICT/, "N: nunca dos destinos")
    // Con el envío Andreani creado pero sin QR final, Mercado Pago sigue disponible.
    assert.equal((await reserve(1034, "mercadopago_refund")).rows[0].choice, "mercadopago_refund")
    assert.equal(await count(db, "select count(*)::int n from order_financial_resolutions where order_id in (1033,1034)"), 2)
    const processing = (await db.query<{ order_id: number; title: string }>("select order_id, title from customer_notifications where type='order_refund_processing' order by order_id")).rows
    assert.deepEqual(processing.map((row) => [row.order_id, row.title]), [[1033, "Reintegro en proceso"], [1034, "Reintegro en proceso"]])
  } finally { await db.close() }
})

test("W: Super Admin cancela dentro del Bulto: queda auditado y el QR sigue bloqueado hasta retirarlo", async () => {
  const db = await setup()
  try {
    for (const orderId of [1035, 1036]) await ready(db, orderId)
    const batch = await closedBundle(db, [1035, 1036])
    await db.query("select super_admin_cancel_order($1,$2,$3,$4)", [1035, superAdmin, "error_administrativo", "Error en la carga del pedido"])
    const event = (await db.query<{ actor_id: string; previous_status: string; new_status: string; metadata: { reasonText: string; batchId: number } }>(
      "select actor_id, previous_status, new_status, metadata from order_audit_events where order_id=1035 and action='order_force_cancelled_by_super_admin'")).rows[0]
    assert.deepEqual([event.actor_id, event.previous_status, event.new_status, event.metadata.reasonText, event.metadata.batchId], [superAdmin, "pagado", "cancelado", "Error en la carga del pedido", batch.id])
    const error = await rejection(handover(db, batch))
    assert.deepEqual(JSON.parse(String(error.detail)).map((issue: { orderId: number }) => issue.orderId), [1035])
    const stock = await blueStock(db)
    await resolve(db, 1035)
    assert.equal(await blueStock(db), stock + 1)
    await db.query("select verify_and_finalize_dispatch_batch($1,$2,'scanner',$3,$4,null)", [batch.id, label(1036), actor, key()])
    await handover(db, batch)
    assert.equal(await count(db, "select count(*)::int n from ordenes where id=1035 and andreani_handed_over_at is not null"), 0, "el cancelado nunca queda entregado")
  } finally { await db.close() }
})

test("cancelación del cliente y de Super Admin: mismo circuito Saldo/Reintegro → NC, sin duplicados ni segundo destino", async () => {
  const db = await setup()
  try {
    const reserve = (orderId: number, choice: string) => db.query<{ id: string; choice: string; amount: number }>(
      "select (r).id, (r).choice, (r).amount from (select reserve_order_financial_resolution($1,$2,$3) r) s", [orderId, adminActor, choice])
    const directCancellation = async (orderId: number) =>
      (await db.query<{ ok: boolean }>("select order_has_admin_direct_cancellation($1) ok", [orderId])).rows[0].ok
    // A: cliente antes del picking (reclamo de cancelación aprobado); B: Super Admin antes del picking.
    await db.exec("update ordenes set andreani_envio_id=null, andreani_tracking=null, payment_method_id='transferencia', payment_id=null where id in (1037,1038)")
    await customerCancel(db, 1037)
    await db.query("select super_admin_cancel_order($1,$2,$3,$4)", [1038, superAdmin, "error_administrativo", "Error en la carga del pedido"])
    assert.equal(await count(db, "select count(*)::int n from order_claims where order_id=1037 and failure_type='cancelar_compra' and status in ('aprobado','reintegro_pendiente')"), 1,
      "A: la NC del cliente se autoriza con su reclamo")
    assert.equal(await directCancellation(1037), false, "A: sin auditoría de Admin, sólo el reclamo")
    assert.equal(await directCancellation(1038), true, "B: la cancelación de Super Admin es una cancelación directa válida")
    assert.equal(await count(db, "select count(*)::int n from ordenes where id in (1037,1038) and estado='cancelado' and financial_status='refund_pending'"), 2)

    // C: ambos eligen destino; F: reintentar el mismo destino es idempotente; G: otro destino se rechaza.
    for (const [orderId, choice, other] of [[1037, "beyonix_credit", "manual_refund"], [1038, "manual_refund", "beyonix_credit"]] as const) {
      const first = (await reserve(orderId, choice)).rows[0]
      assert.equal(first.choice, choice)
      assert.equal((await reserve(orderId, choice)).rows[0].id, first.id, `F ${orderId}: reintento idempotente`)
      await assert.rejects(reserve(orderId, other), /FINANCIAL_CHOICE_CONFLICT/, `G ${orderId}: nunca dos destinos`)
    }
    assert.equal(await count(db, "select count(*)::int n from order_financial_resolutions where order_id in (1037,1038)"), 2)

    // H: Super Admin cancela con la mercadería en el Bulto → NC y dinero bloqueados hasta resolver el stock.
    await ready(db, 1039)
    await closedBundle(db, [1039])
    await db.query("select super_admin_cancel_order($1,$2,$3,$4)", [1039, superAdmin, "error_administrativo", "Error en la carga del pedido"])
    assert.equal(await directCancellation(1039), true)
    await assert.rejects(db.query("insert into order_credit_notes(order_id) values (1039)"), /DISPATCH_PHYSICAL_RESOLUTION_REQUIRED/, "H: sin NC con stock pendiente")
    await assert.rejects(reserve(1039, "manual_refund"), /DISPATCH_PHYSICAL_RESOLUTION_REQUIRED/, "H: sin destino con stock pendiente")
    await resolve(db, 1039)
    assert.equal((await reserve(1039, "beyonix_credit")).rows[0].choice, "beyonix_credit", "stock resuelto: entra al circuito normal")
  } finally { await db.close() }
})

test("devolución después del despacho: sin inspección no se mueve dinero; aprobar o rechazar, una sola vez", async () => {
  const db = await setup()
  try {
    const reserve = (orderId: number, choice: string) => db.query<{ id: string; choice: string }>(
      "select (r).id, (r).choice from (select reserve_order_financial_resolution($1,$2,$3) r) s", [orderId, adminActor, choice])
    const inspect = (orderId: number, state: string, decision: string, reason: string | null = null, message: string | null = null) =>
      db.query<{ id: number; physical_state: string; decision: string }>(
        "select (r).id, (r).physical_state, (r).decision from (select record_order_return_inspection($1,$2,$3,$4,$5,$6) r) s",
        [orderId, adminActor, state, decision, reason, message])
    const financialStatus = async (orderId: number) =>
      (await db.query<{ s: string }>("select financial_status s from ordenes where id=$1", [orderId])).rows[0].s
    // Dos ventas por transferencia entregadas a Andreani y canceladas por Super Admin (retención de stock).
    await db.exec("update ordenes set payment_method_id='transferencia', payment_id=null where id in (1037,1038)")
    for (const orderId of [1037, 1038]) await ready(db, orderId)
    await handover(db, await closedBundle(db, [1037, 1038]))
    for (const orderId of [1037, 1038]) {
      await db.query("select super_admin_cancel_order($1,$2,$3,$4)", [orderId, superAdmin, "solicitud_cliente", "El cliente devolvió el paquete"])
    }
    assert.equal(await financialStatus(1037), "refund_pending")

    // Sin inspección: ni resolución, ni reintegro, ni NC con dinero (cualquier camino).
    await assert.rejects(reserve(1037, "manual_refund"), /FINANCIAL_RETURN_INSPECTION_REQUIRED/)
    await assert.rejects(db.query("insert into order_refund_proofs(order_id) values (1037)"), /RETURN_INSPECTION_REQUIRED/)
    await assert.rejects(db.query("insert into mercadopago_order_refunds(order_id,status) values (1037,'processing')"), /RETURN_INSPECTION_REQUIRED/)
    await assert.rejects(db.query("insert into order_credit_notes(order_id,destination) values (1037,'external_refund')"), /RETURN_INSPECTION_REQUIRED/)

    // C: no recibida nunca se aprueba. G: rechazar exige motivo. Pre-despacho: no aplica.
    await assert.rejects(inspect(1037, "not_received", "approved"), /RETURN_NOT_RECEIVED/)
    await assert.rejects(inspect(1037, "damaged", "rejected", "corto"), /RETURN_REJECTION_REASON_REQUIRED/)
    await db.exec("update ordenes set andreani_envio_id=null, andreani_tracking=null where id=1031")
    await db.query("select super_admin_cancel_order($1,$2,$3,$4)", [1031, superAdmin, "error_administrativo", "Error en la carga del pedido"])
    await assert.rejects(inspect(1031, "received_ok", "approved"), /RETURN_INSPECTION_NOT_APPLICABLE/, "la cancelación previa no se inspecciona")

    // D/H/I: rechazo por producto dañado: cierra el dinero sin moverlo.
    const rejected = (await inspect(1037, "damaged", "rejected", "Pantalla rota por golpe", "Te escribimos con el detalle.")).rows[0]
    assert.equal(await financialStatus(1037), "refund_rejected")
    assert.equal((await inspect(1037, "damaged", "rejected", "Pantalla rota por golpe")).rows[0].id, rejected.id, "J: reintento idempotente")
    await assert.rejects(inspect(1037, "received_ok", "approved"), /RETURN_INSPECTION_CONFLICT/, "nunca una segunda decisión distinta")
    await assert.rejects(reserve(1037, "beyonix_credit"), /RETURN_MONEY_REJECTED|FINANCIAL_NOT_PENDING/, "I: sin reintegro ni saldo")
    await assert.rejects(db.query("insert into customer_credit_movements(user_id,movement_type,amount,order_id) values ($1,'credit',10000,1037)", [customer]),
      /RETURN_MONEY_REJECTED/, "H: no acredita saldo")
    await assert.rejects(db.query("insert into order_credit_notes(order_id,destination) values (1037,'customer_balance')"), /RETURN_MONEY_REJECTED/)
    await db.query("insert into order_credit_notes(order_id,destination) values (1037,'none')")
    assert.equal(await count(db, "select count(*)::int n from order_credit_notes where order_id=1037 and destination='none'"), 1,
      "la obligación fiscal sigue su curso: una NC sin dinero no queda bloqueada")
    const audit = (await db.query<{ actor_id: string; metadata: { physicalState: string; decision: string; reason: string } }>(
      "select actor_id, metadata from order_audit_events where order_id=1037 and action='return_inspection_recorded'")).rows
    assert.deepEqual(audit.map((row) => [row.actor_id, row.metadata.physicalState, row.metadata.decision, row.metadata.reason]),
      [[adminActor, "damaged", "rejected", "Pantalla rota por golpe"]], "auditoría única")
    const notice = (await db.query<{ body: string }>("select body from customer_notifications where source_key='order:1037:refund-rejected'")).rows
    assert.deepEqual(notice.map((row) => row.body), ["Revisamos la devolución de tu pedido BX-2037 y no pudimos aprobar el reintegro. Te escribimos con el detalle."])
    assert.doesNotMatch(notice[0].body, /Pantalla rota|RETURN_|refund_rejected/, "el motivo interno no llega al cliente")

    // B: recibida correctamente y aprobada: entra al circuito normal (saldo o reintegro), una sola vez.
    await inspect(1038, "received_ok", "approved")
    assert.equal(await financialStatus(1038), "refund_pending")
    assert.equal((await db.query<{ ok: boolean }>("select order_has_admin_direct_cancellation(1038) ok")).rows[0].ok, true, "autoriza la NC de la cancelación")
    const resolution = (await reserve(1038, "manual_refund")).rows[0]
    assert.equal(resolution.choice, "manual_refund")
    assert.equal((await reserve(1038, "manual_refund")).rows[0].id, resolution.id)
    await assert.rejects(reserve(1038, "beyonix_credit"), /FINANCIAL_CHOICE_CONFLICT/)
  } finally { await db.close() }
})
