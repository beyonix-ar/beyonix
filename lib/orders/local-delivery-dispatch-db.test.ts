import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

// Envío BEYONIX en Despachos (20261103120000 = A, 20261103130000 = B) contra las migraciones reales:
// pickeo común, bultos físicos BX-PKG, confirmación de cada etiqueta, guard de
// "En camino" y separación total del circuito Andreani.

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8")
const actor = "20000000-0000-4000-8000-000000000002"
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
  "supabase/migrations/20261017100000_dispatch_finalize_on_verification.sql",
  "supabase/migrations/20261017110000_super_admin_force_cancellation.sql",
  "supabase/migrations/20261021100000_dispatch_andreani_label_scan_confirmation.sql",
]
// A: estructural, compatible con el código anterior. B: guarda estricta de En camino (después del deploy).
const MIGRATION_A = "supabase/migrations/20261103120000_local_delivery_parcels_labels.sql"
const MIGRATION_B = "supabase/migrations/20261103130000_local_delivery_in_transit_parcels_guard.sql"
// C: order_change_status bajo lock en En camino + registro atómico de etiquetas generadas.
const MIGRATION_C = "supabase/migrations/20261104120000_local_delivery_change_guard_and_label_generation.sql"
type MigrationStage = "none" | "A" | "AB" | "ABC"

const LOCAL = 1041
const LOCAL_RESIDUAL = 1042
const ANDREANI = 1043

async function setup(stage: MigrationStage = "A") {
  const db = new PGlite()
  for (const file of MIGRATIONS) {
    await db.exec(read(file))
    if (file.endsWith("dispatch-schema.sql")) await db.exec(`
      alter table ordenes add column andreani_tracking text;
      alter table ordenes add column delivered_at timestamptz;
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
    insert into product_cost_entries(product_id,variant_id,received_quantity) values (1,11,10),(1,12,10),(2,null,10);
    insert into ordenes(id,shipping_provider,andreani_envio_id,andreani_creation_status,andreani_tracking) values
      (${LOCAL},'beyonix',null,null,null),
      (${LOCAL_RESIDUAL},'beyonix','ENV-RESIDUAL','created','360000009999'),
      (${ANDREANI},'andreani','ENV-1043','created','360000001043');
    insert into orden_items(id,orden_id,producto_id,variante_id,cantidad) values
      (1,${LOCAL},1,11,2),(2,${LOCAL},2,null,1),(3,${LOCAL_RESIDUAL},1,12,1),(4,${ANDREANI},1,12,1);
  `)
  await db.exec("select refresh_inventory_stock(1); select refresh_inventory_stock(2);")
  if (stage !== "none") await db.exec(read(MIGRATION_A))
  if (stage === "AB" || stage === "ABC") await db.exec(read(MIGRATION_B))
  if (stage === "ABC") await db.exec(read(MIGRATION_C))
  return db
}

const CODES: Record<number, string[]> = { [LOCAL]: ["BAR-A-RED", "SKU-A-RED", "BAR-B"], [LOCAL_RESIDUAL]: ["BAR-A-BLUE"], [ANDREANI]: ["BAR-A-BLUE"] }
const scan = (db: PGlite, orderId: number, code: string) =>
  db.query<{ result: { status: string; scanned: number; expected: number } }>("select scan_order_preparation_code($1,$2,$3,$4) result", [orderId, code, actor, key()])
async function pick(db: PGlite, orderId: number) {
  await db.query("select begin_order_preparation($1,$2)", [orderId, actor])
  for (const code of CODES[orderId]) await scan(db, orderId, code)
}
const defineParcels = (db: PGlite, orderId: number, count: number, requestKey = key()) =>
  db.query("select set_order_package_parcels($1,$2,$3,$4)", [orderId, count, actor, requestKey])
const confirm = async (db: PGlite, orderId: number, code: string) =>
  (await db.query<{ result: { code: string; parcelIndex: number; parcelCount: number; confirmed: number; complete: boolean; duplicate: boolean } }>(
    "select confirm_local_delivery_parcel($1,$2,$3) result", [orderId, code, actor])).rows[0].result
const reasons = async (db: PGlite, orderId: number) =>
  (await db.query<{ reasons: string[] }>("select dispatch_order_block_reasons($1) reasons", [orderId])).rows[0].reasons
const parcels = async (db: PGlite, orderId: number) =>
  (await db.query<{ barcode: string; parcel_index: number; parcel_count: number; attempt_number: number }>(
    "select p.barcode,p.parcel_index,p.parcel_count,p.attempt_number from order_package_parcels p join order_packages k on k.id=p.package_id and k.attempt_number=p.attempt_number where p.order_id=$1 order by p.parcel_index", [orderId])).rows
const markInTransit = (db: PGlite, orderId: number) => db.query("update ordenes set estado='en_camino' where id=$1", [orderId])

test("motivos de bloqueo: Envío BEYONIX deja de ser 'wrong_carrier' y queda siempre fuera del circuito Andreani; Andreani no cambia", async () => {
  const before = await setup("none")
  const andreaniBefore = await reasons(before, ANDREANI)
  assert.ok((await reasons(before, LOCAL)).includes("wrong_carrier"), "antes, el pickeo local estaba bloqueado")
  const db = await setup()
  assert.deepEqual(await reasons(db, ANDREANI), andreaniBefore)
  assert.deepEqual(await reasons(db, LOCAL), ["shipment_pending"])
  // Un andreani_envio_id residual no habilita el circuito Andreani.
  assert.deepEqual(await reasons(db, LOCAL_RESIDUAL), ["shipment_pending"])
  await db.query("update ordenes set shipping_provider='otro' where id=$1", [LOCAL])
  assert.ok((await reasons(db, LOCAL)).includes("wrong_carrier"), "otro transportista sigue bloqueado")
})

test("pickeo común: Envío BEYONIX escanea código y SKU con la misma validación de artículo, variante y cantidad", async () => {
  const db = await setup()
  await db.query("select begin_order_preparation($1,$2)", [LOCAL, actor])
  await assert.rejects(scan(db, LOCAL, "BAR-A-BLUE"), /DISPATCH_WRONG_SKU_OR_VARIANT/, "variante equivocada")
  await assert.rejects(scan(db, LOCAL, "NO-EXISTE"), /DISPATCH_CODE_UNKNOWN/)
  assert.equal((await scan(db, LOCAL, "BAR-A-RED")).rows[0].result.scanned, 1)
  assert.equal((await scan(db, LOCAL, "sku-a-red")).rows[0].result.scanned, 2, "el SKU también sirve")
  await assert.rejects(scan(db, LOCAL, "BAR-A-RED"), /DISPATCH_QUANTITY_EXCEEDED/)
  assert.equal((await scan(db, LOCAL, "BAR-B")).rows[0].result.status, "prepared")
})

test("bultos: 1 o N bultos con BX-PKG únicos 1/N; misma cantidad es idempotente y otra exige rearmar", async () => {
  const db = await setup()
  await pick(db, LOCAL)
  await pick(db, LOCAL_RESIDUAL)
  await defineParcels(db, LOCAL_RESIDUAL, 1)
  assert.deepEqual((await parcels(db, LOCAL_RESIDUAL)).map((row) => [row.barcode, row.parcel_index, row.parcel_count]), [["BX-PKG-2042-01", 1, 1]])
  await defineParcels(db, LOCAL, 2)
  const defined = await parcels(db, LOCAL)
  assert.deepEqual(defined.map((row) => [row.barcode, row.parcel_index, row.parcel_count]), [["BX-PKG-2041-01", 1, 2], ["BX-PKG-2041-02", 2, 2]])
  assert.equal(new Set(defined.map((row) => row.barcode)).size, 2)
  await defineParcels(db, LOCAL, 2)
  assert.deepEqual(await parcels(db, LOCAL), defined, "misma cantidad: mismos códigos")
  await assert.rejects(defineParcels(db, LOCAL, 3), /DISPATCH_LOCAL_PARCELS_DEFINED/)
  assert.deepEqual(await parcels(db, LOCAL), defined, "el rechazo no toca los bultos")
  const audit = await db.query<{ count: number }>("select count(*)::int count from order_audit_events where order_id=$1 and action='order_parcels_defined'", [LOCAL])
  assert.equal(audit.rows[0].count, 1)
})

test("confirmación física: cada BX-PKG se escanea una vez; otro pedido, producto o código desconocido se rechazan", async () => {
  const db = await setup()
  await pick(db, LOCAL)
  await assert.rejects(confirm(db, LOCAL, "BX-PKG-2041-01"), /DISPATCH_LOCAL_PARCELS_PENDING/)
  await defineParcels(db, LOCAL, 2)
  await pick(db, LOCAL_RESIDUAL)
  await defineParcels(db, LOCAL_RESIDUAL, 1)
  await assert.rejects(confirm(db, LOCAL, "BX-PKG-2042-01"), (error: Error & { detail?: string }) => /DISPATCH_LABEL_MISMATCH/.test(error.message) && error.detail === String(LOCAL))
  await assert.rejects(confirm(db, LOCAL, "BAR-A-RED"), /DISPATCH_LOCAL_PARCEL_CODE_REQUIRED/)
  await assert.rejects(confirm(db, LOCAL, "BX-PKG-2041-09"), /DISPATCH_PARCEL_UNKNOWN/)
  const first = await confirm(db, LOCAL, " bx-pkg-2041-01 ")
  assert.deepEqual([first.code, first.parcelIndex, first.confirmed, first.complete, first.duplicate], ["BX-PKG-2041-01", 1, 1, false, false])
  assert.equal((await confirm(db, LOCAL, "BX-PKG-2041-01")).duplicate, true)
  assert.equal((await confirm(db, LOCAL, "BX-PKG-2041-02")).complete, true)
  const audit = await db.query<{ count: number }>("select count(*)::int count from order_audit_events where order_id=$1 and action='local_delivery_parcel_confirmed'", [LOCAL])
  assert.equal(audit.rows[0].count, 2, "un evento por bulto, sin duplicados")
  await assert.rejects(confirm(db, ANDREANI, "BX-PKG-2043-01"), /DISPATCH_LOCAL_DELIVERY_ONLY/)
})

test("C. Migración B + código nuevo: En camino exige todos los bultos confirmados; Andreani sin cambios", async () => {
  const db = await setup("AB")
  await assert.rejects(markInTransit(db, LOCAL), /LOCAL_DELIVERY_PARCELS_NOT_READY/, "sin preparación")
  await pick(db, LOCAL)
  await defineParcels(db, LOCAL, 2)
  await confirm(db, LOCAL, "BX-PKG-2041-01")
  await assert.rejects(markInTransit(db, LOCAL), /LOCAL_DELIVERY_PARCELS_NOT_READY/, "falta un bulto")
  await confirm(db, LOCAL, "BX-PKG-2041-02")
  await markInTransit(db, LOCAL)
  assert.equal((await db.query<{ estado: string }>("select estado from ordenes where id=$1", [LOCAL])).rows[0].estado, "en_camino")
  await markInTransit(db, ANDREANI)
})

test("rearmado (con B): intento nuevo con códigos -R2, las etiquetas anteriores quedan vencidas; ya En camino no se rearma", async () => {
  const db = await setup("AB")
  await pick(db, LOCAL)
  await defineParcels(db, LOCAL, 1)
  await confirm(db, LOCAL, "BX-PKG-2041-01")
  await db.query("select reset_order_preparation($1,$2,$3,$4)", [LOCAL, actor, key(), "Rearmado por caja dañada"])
  for (const code of CODES[LOCAL]) await scan(db, LOCAL, code)
  await defineParcels(db, LOCAL, 2)
  assert.deepEqual((await parcels(db, LOCAL)).map((row) => row.barcode), ["BX-PKG-2041-R2-01", "BX-PKG-2041-R2-02"])
  await assert.rejects(confirm(db, LOCAL, "BX-PKG-2041-01"), /DISPATCH_PARCEL_STALE/)
  await assert.rejects(markInTransit(db, LOCAL), /LOCAL_DELIVERY_PARCELS_NOT_READY/, "la confirmación anterior no cuenta")
  await confirm(db, LOCAL, "BX-PKG-2041-R2-01")
  await confirm(db, LOCAL, "BX-PKG-2041-R2-02")
  await markInTransit(db, LOCAL)
  await assert.rejects(db.query("select reset_order_preparation($1,$2,$3,$4)", [LOCAL, actor, key(), "Rearmado tardío del pedido"]), /DISPATCH_LOCAL_ALREADY_DISPATCHED/)
})

// ── Compatibilidad del despliegue en dos pasos ──────────────────────────────

// Mismo UPDATE condicional que hacía el código desplegado antes de esta etapa
// (app/api/admin/dispatch/local/route.ts en 41dcd22): sin bultos ni etiquetas.
const legacyTransition = (db: PGlite, orderId: number, fromEstado: string, action: string) =>
  db.query<{ id: number }>(
    `update ordenes set estado=$3${action === "entregado" ? ", delivered_at=now()" : ""}
     where id=$1 and estado=$2 and shipping_provider='beyonix' and financial_status='payment_confirmed' and cancelled_at is null
     returning id`, [orderId, fromEstado, action])

test("A. Migración A + código anterior: un pedido local sin bultos pasa a En camino y Entregado como antes (sin error)", async () => {
  const db = await setup("A")
  assert.deepEqual((await legacyTransition(db, LOCAL, "pagado", "en_camino")).rows, [{ id: LOCAL }])
  assert.deepEqual((await legacyTransition(db, LOCAL, "en_camino", "entregado")).rows, [{ id: LOCAL }])
  const row = (await db.query<{ estado: string }>("select estado from ordenes where id=$1", [LOCAL])).rows[0]
  assert.equal(row.estado, "entregado")
  // Lo que el código anterior hacía con un pedido con envío residual tampoco cambia.
  assert.deepEqual((await legacyTransition(db, LOCAL_RESIDUAL, "pagado", "en_camino")).rows, [{ id: LOCAL_RESIDUAL }])
})

test("B. Migración A + código nuevo: preparación, bultos y confirmación funcionan; la base todavía no frena En camino (lo exige la aplicación)", async () => {
  const db = await setup("A")
  await pick(db, LOCAL)
  await defineParcels(db, LOCAL, 2)
  assert.equal((await confirm(db, LOCAL, "BX-PKG-2041-01")).confirmed, 1)
  assert.equal((await db.query<{ ready: boolean }>("select local_delivery_parcels_ready($1) ready", [LOCAL])).rows[0].ready, false)
  assert.equal((await confirm(db, LOCAL, "BX-PKG-2041-02")).complete, true)
  assert.equal((await db.query<{ ready: boolean }>("select local_delivery_parcels_ready($1) ready", [LOCAL])).rows[0].ready, true)
  // Sin B no hay guarda en la base: un pedido sin bultos todavía puede pasar (ventana de despliegue).
  await pick(db, LOCAL_RESIDUAL)
  await markInTransit(db, LOCAL_RESIDUAL)
  const trigger = await db.query("select 1 from pg_trigger where tgname='guard_local_delivery_in_transit'")
  assert.equal(trigger.rows.length, 0, "A no instala la guarda estricta")
})

test("C. Migración B: el código anterior, ya sin bultos confirmados, recibe el rechazo de la base (por eso B va después del deploy)", async () => {
  const db = await setup("AB")
  await assert.rejects(legacyTransition(db, LOCAL, "pagado", "en_camino"), /LOCAL_DELIVERY_PARCELS_NOT_READY/)
  // Ya En camino antes de B: Entregado sigue funcionando (la guarda sólo actúa al entrar a en_camino).
  await db.query("alter table ordenes disable trigger guard_local_delivery_in_transit")
  await legacyTransition(db, LOCAL_RESIDUAL, "pagado", "en_camino")
  await db.query("alter table ordenes enable trigger guard_local_delivery_in_transit")
  assert.deepEqual((await legacyTransition(db, LOCAL_RESIDUAL, "en_camino", "entregado")).rows, [{ id: LOCAL_RESIDUAL }])
})

test("D. Andreani igual sin migraciones, con A y con A+B: motivos de bloqueo, pickeo y En camino", async () => {
  const outcomes: string[] = []
  for (const stage of ["none", "A", "AB"] as const) {
    const db = await setup(stage)
    const blockReasons = await reasons(db, ANDREANI)
    await pick(db, ANDREANI)
    const pkg = (await db.query<{ status: string }>("select status from order_packages where order_id=$1", [ANDREANI])).rows[0]
    await markInTransit(db, ANDREANI)
    const estado = (await db.query<{ estado: string }>("select estado from ordenes where id=$1", [ANDREANI])).rows[0].estado
    outcomes.push(JSON.stringify({ blockReasons, pkg, estado }))
  }
  assert.equal(new Set(outcomes).size, 1, outcomes.join(" | "))
})

// ── En camino atómico del código nuevo (seguro con A, antes de B) ──────────

const markInTransitRpc = async (db: PGlite, orderId: number, fromEstado = "pagado") =>
  (await db.query<{ id: number; estado: string }>("select id, estado from mark_local_delivery_in_transit($1,$2,$3)", [orderId, fromEstado, actor])).rows
const estadoOf = async (db: PGlite, orderId: number) => (await db.query<{ estado: string }>("select estado from ordenes where id=$1", [orderId])).rows[0].estado

for (const stage of ["A", "AB", "ABC"] as const) {
  test(`código nuevo con ${stage}: En camino atómico sólo con todos los bultos del armado vigente confirmados`, async () => {
    const db = await setup(stage)
    assert.deepEqual(await markInTransitRpc(db, LOCAL), [], "sin preparación: 0 filas")
    await pick(db, LOCAL)
    await defineParcels(db, LOCAL, 2)
    await confirm(db, LOCAL, "BX-PKG-2041-01")
    assert.deepEqual(await markInTransitRpc(db, LOCAL), [], "falta un bulto: 0 filas")
    await confirm(db, LOCAL, "BX-PKG-2041-02")
    assert.deepEqual(await markInTransitRpc(db, LOCAL, "preparado"), [], "estado de origen distinto: 0 filas")
    assert.deepEqual(await markInTransitRpc(db, LOCAL), [{ id: LOCAL, estado: "en_camino" }])
    assert.deepEqual(await markInTransitRpc(db, LOCAL), [], "ya En camino: no repite")
    assert.deepEqual(await markInTransitRpc(db, ANDREANI), [], "nunca mueve un pedido Andreani")
  })

  test(`código nuevo con ${stage}: rearmado entre la validación y el write => 0 filas, sigue Preparando`, async () => {
    const db = await setup(stage)
    await pick(db, LOCAL)
    await defineParcels(db, LOCAL, 1)
    await confirm(db, LOCAL, "BX-PKG-2041-01")
    // La aplicación validó con este snapshot (todo listo)...
    assert.equal((await db.query<{ ready: boolean }>("select local_delivery_parcels_ready($1) ready", [LOCAL])).rows[0].ready, true)
    // ...y antes del write otro operador rearma el pedido.
    await db.query("select reset_order_preparation($1,$2,$3,$4)", [LOCAL, actor, key(), "Rearmado por caja dañada"])
    assert.deepEqual(await markInTransitRpc(db, LOCAL), [])
    assert.equal(await estadoOf(db, LOCAL), "pagado")
    // Rearmado completo con otra cantidad: los BX-PKG anteriores no cuentan.
    for (const code of CODES[LOCAL]) await scan(db, LOCAL, code)
    await defineParcels(db, LOCAL, 2)
    assert.deepEqual(await markInTransitRpc(db, LOCAL), [], "bultos nuevos sin confirmar")
    await confirm(db, LOCAL, "BX-PKG-2041-R2-01")
    assert.deepEqual(await markInTransitRpc(db, LOCAL), [], "un bulto del armado vigente sin confirmar")
    await confirm(db, LOCAL, "BX-PKG-2041-R2-02")
    assert.deepEqual(await markInTransitRpc(db, LOCAL), [{ id: LOCAL, estado: "en_camino" }])
  })

  test(`código nuevo con ${stage}: pago, cancelación o proveedor que cambian antes del write => 0 filas`, async () => {
    for (const change of ["financial_status='refund_pending'", "cancelled_at=now()", "shipping_provider='andreani'", "payment_status='rechazado'", "paid_at=null"]) {
      const db = await setup(stage)
      await pick(db, LOCAL)
      await defineParcels(db, LOCAL, 1)
      await confirm(db, LOCAL, "BX-PKG-2041-01")
      await db.query(`update ordenes set ${change} where id=$1`, [LOCAL])
      assert.deepEqual(await markInTransitRpc(db, LOCAL), [], change)
      assert.equal(await estadoOf(db, LOCAL), "pagado", change)
    }
  })
}

test("separación: un pedido Envío BEYONIX (aun con envío Andreani residual) nunca entra a un Bulto general Andreani", async () => {
  const db = await setup()
  await pick(db, LOCAL_RESIDUAL)
  await defineParcels(db, LOCAL_RESIDUAL, 1)
  await confirm(db, LOCAL_RESIDUAL, "BX-PKG-2042-01")
  const batch = (await db.query<{ id: number }>("select (create_dispatch_batch($1,$2)).id", [actor, key()])).rows[0]
  await assert.rejects(db.query("select add_order_to_dispatch_batch($1,$2,$3)", [batch.id, LOCAL_RESIDUAL, actor]), /DISPATCH_(ORDER_BLOCKED|IDENTIFICATION_PENDING)/)
  await assert.rejects(db.query("select confirm_order_andreani_label($1,$2,$3)", [LOCAL_RESIDUAL, "360000009999", actor]), /DISPATCH_LOCAL_DELIVERY_NO_ANDREANI/)
  const pkg = (await db.query<{ identification_method: string | null }>("select identification_method from order_packages where order_id=$1", [LOCAL_RESIDUAL])).rows[0]
  assert.equal(pkg.identification_method, null)
  // Andreani conserva su confirmación por seguimiento.
  await pick(db, ANDREANI)
  const andreani = (await db.query<{ result: { duplicate: boolean } }>("select confirm_order_andreani_label($1,$2,$3) result", [ANDREANI, "360000001043", actor])).rows[0].result
  assert.equal(andreani.duplicate, false)
})

test("permisos: las funciones nuevas sólo para service_role con operador verificado", async () => {
  const db = await setup()
  await pick(db, LOCAL)
  await defineParcels(db, LOCAL, 1)
  await db.query("select set_config('request.jwt.claim.role','authenticated',false)")
  await assert.rejects(confirm(db, LOCAL, "BX-PKG-2041-01"), /DISPATCH_FORBIDDEN|permission denied/)
})

// ── Migración C ─────────────────────────────────────────────────────────────

const preparedLocal = async () => {
  const db = await setup("ABC")
  await pick(db, LOCAL)
  await defineParcels(db, LOCAL, 1)
  await confirm(db, LOCAL, "BX-PKG-2041-01")
  return db
}
const auditActions = async (db: PGlite, orderId: number) =>
  (await db.query<{ action: string }>("select action from order_audit_events where order_id=$1 order by id", [orderId])).rows.map((row) => row.action)

test("C: En camino atómico rechaza bajo lock los cambios pendientes (misma lista que el servicio); el resto avanza", async () => {
  for (const status of ["change_requested", "extra_payment_pending"]) {
    const db = await preparedLocal()
    const before = await auditActions(db, LOCAL)
    await db.query("update ordenes set order_change_status=$2 where id=$1", [LOCAL, status])
    assert.deepEqual(await markInTransitRpc(db, LOCAL), [], status)
    assert.equal(await estadoOf(db, LOCAL), "pagado", status)
    assert.deepEqual(await auditActions(db, LOCAL), before, `${status}: 0 efectos`)
  }
  for (const status of [null, "change_approved", "rejected"]) {
    const db = await preparedLocal()
    await db.query("update ordenes set order_change_status=$2 where id=$1", [LOCAL, status])
    assert.deepEqual(await markInTransitRpc(db, LOCAL), [{ id: LOCAL, estado: "en_camino" }], String(status))
  }
})

test("C: sin C, la RPC anterior dejaba avanzar con un cambio pendiente (regresión cubierta)", async () => {
  const db = await setup("AB")
  await pick(db, LOCAL)
  await defineParcels(db, LOCAL, 1)
  await confirm(db, LOCAL, "BX-PKG-2041-01")
  await db.query("update ordenes set order_change_status='change_requested' where id=$1", [LOCAL])
  assert.deepEqual(await markInTransitRpc(db, LOCAL), [{ id: LOCAL, estado: "en_camino" }])
})

type Generated = { packageId: number; attempt: number; parcelCount: number; reprint: boolean }
const recordGenerated = async (db: PGlite, orderId: number, packageId: number, attempt: number, barcodes: string[]) =>
  (await db.query<{ result: Generated }>("select record_local_delivery_labels_generated($1,$2,$3,$4,$5) result", [orderId, actor, packageId, attempt, barcodes])).rows[0].result
const currentPackage = async (db: PGlite, orderId: number) =>
  (await db.query<{ id: number; attempt_number: number }>("select id, attempt_number from order_packages where order_id=$1", [orderId])).rows[0]
const generatedEvents = async (db: PGlite, orderId: number) =>
  (await db.query<{ metadata: { attempt: number; barcodes: string[]; reprint: boolean } }>(
    "select metadata from order_audit_events where order_id=$1 and action='local_delivery_labels_generated' order by id", [orderId])).rows.map((row) => row.metadata)

test("C: generación de etiquetas = evento 'generated' del intento vigente; regenerar = mismos BX-PKG con reprint", async () => {
  const db = await setup("ABC")
  await pick(db, LOCAL)
  await defineParcels(db, LOCAL, 2)
  const pkg = await currentPackage(db, LOCAL)
  const codes = ["BX-PKG-2041-01", "BX-PKG-2041-02"]
  assert.equal((await recordGenerated(db, LOCAL, pkg.id, 1, codes)).reprint, false)
  assert.equal((await recordGenerated(db, LOCAL, pkg.id, 1, codes)).reprint, true)
  assert.deepEqual((await generatedEvents(db, LOCAL)).map((event) => [event.attempt, event.barcodes, event.reprint]), [[1, codes, false], [1, codes, true]])
  assert.equal((await auditActions(db, LOCAL)).includes("local_delivery_labels_printed"), false, "nunca afirma una impresión física")
  // Un evento con el nombre anterior del mismo intento también cuenta como generación previa.
  await db.query("select reset_order_preparation($1,$2,$3,$4)", [LOCAL, actor, key(), "Rearmado por caja dañada"])
  for (const code of CODES[LOCAL]) await scan(db, LOCAL, code)
  await defineParcels(db, LOCAL, 1)
  await db.query("insert into order_audit_events(order_id,action,metadata) values ($1,'local_delivery_labels_printed',jsonb_build_object('packageId',$2::bigint,'attempt',2))", [LOCAL, pkg.id])
  assert.equal((await recordGenerated(db, LOCAL, pkg.id, 2, ["BX-PKG-2041-R2-01"])).reprint, true)
})

test("C: después de un rearmado, las etiquetas del intento anterior NO se registran ni se devuelven (DISPATCH_PARCEL_STALE)", async () => {
  const db = await setup("ABC")
  await pick(db, LOCAL)
  await defineParcels(db, LOCAL, 1)
  const pkg = await currentPackage(db, LOCAL)
  // La ruta leyó el intento 1 y, antes de registrar, otro operador rearma.
  const stale = ["BX-PKG-2041-01"]
  await db.query("select reset_order_preparation($1,$2,$3,$4)", [LOCAL, actor, key(), "Rearmado por caja dañada"])
  await assert.rejects(recordGenerated(db, LOCAL, pkg.id, 1, stale), /DISPATCH_PARCEL_STALE/, "intento viejo, pickeo pendiente")
  for (const code of CODES[LOCAL]) await scan(db, LOCAL, code)
  await defineParcels(db, LOCAL, 2)
  await assert.rejects(recordGenerated(db, LOCAL, pkg.id, 1, stale), /DISPATCH_PARCEL_STALE/, "intento viejo")
  await assert.rejects(recordGenerated(db, LOCAL, pkg.id, 2, ["BX-PKG-2041-R2-01"]), /DISPATCH_PARCEL_STALE/, "incompleto")
  await assert.rejects(recordGenerated(db, LOCAL, pkg.id, 2, ["BX-PKG-2041-R2-02", "BX-PKG-2041-R2-01"]), /DISPATCH_PARCEL_STALE/, "otro orden")
  await assert.rejects(recordGenerated(db, LOCAL, pkg.id + 99, 2, ["BX-PKG-2041-R2-01", "BX-PKG-2041-R2-02"]), /DISPATCH_PARCEL_STALE/, "otra preparación")
  assert.deepEqual(await generatedEvents(db, LOCAL), [], "0 efectos")
  assert.equal((await recordGenerated(db, LOCAL, pkg.id, 2, ["BX-PKG-2041-R2-01", "BX-PKG-2041-R2-02"])).reprint, false)
})

test("C: generación rechazada para cancelados, Andreani y sin permisos", async () => {
  const db = await setup("ABC")
  await pick(db, LOCAL)
  await defineParcels(db, LOCAL, 1)
  const pkg = await currentPackage(db, LOCAL)
  for (const change of ["financial_status='refund_pending'", "cancelled_at=now()"]) {
    await db.query(`update ordenes set ${change} where id=$1`, [LOCAL])
    await assert.rejects(recordGenerated(db, LOCAL, pkg.id, 1, ["BX-PKG-2041-01"]), /LOCAL_DELIVERY_LABEL_ORDER_CANCELLED/, change)
    await db.query("update ordenes set financial_status='payment_confirmed', cancelled_at=null where id=$1", [LOCAL])
  }
  await pick(db, ANDREANI)
  const andreani = await currentPackage(db, ANDREANI)
  await assert.rejects(recordGenerated(db, ANDREANI, andreani.id, 1, []), /DISPATCH_LOCAL_DELIVERY_ONLY/)
  await db.query("select set_config('request.jwt.claim.role','authenticated',false)")
  await assert.rejects(recordGenerated(db, LOCAL, pkg.id, 1, ["BX-PKG-2041-01"]), /DISPATCH_FORBIDDEN|permission denied/)
  assert.deepEqual(await generatedEvents(db, LOCAL), [])
})

test("compatibilidad: A+B → C con el código anterior (auditoría directa de etiquetas, misma RPC de En camino) y Andreani igual", async () => {
  const before = await setup("AB")
  const db = await setup("ABC")
  for (const target of [before, db]) {
    await pick(target, LOCAL)
    await defineParcels(target, LOCAL, 1)
    // Ruta de etiquetas anterior: insert directo en la auditoría existente.
    await target.query("insert into order_audit_events(order_id,actor_type,actor_id,action,metadata) values ($1,'admin',$2,'local_delivery_labels_printed','{}'::jsonb)", [LOCAL, actor])
    await confirm(target, LOCAL, "BX-PKG-2041-01")
    assert.deepEqual(await markInTransitRpc(target, LOCAL), [{ id: LOCAL, estado: "en_camino" }])
  }
  // Andreani: mismos motivos de bloqueo con y sin C.
  assert.deepEqual(await reasons(db, ANDREANI), await reasons(before, ANDREANI))
  // El residuo Andreani de LOCAL_RESIDUAL ya no lo bloquea con C.
  assert.ok(!(await reasons(db, LOCAL_RESIDUAL)).includes("tracking_in_circuit"))
})
