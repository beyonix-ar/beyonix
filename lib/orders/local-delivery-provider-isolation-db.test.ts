import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

import { isOrderDispatchCutoffReached, type DispatchCutoffOrder } from "./dispatch-cutoff.ts"

// Proveedor efectivo (migración C, 20261104120000) contra las migraciones
// reales de Despachos, cancelación (cliente, Admin, Super Admin) y resolución
// financiera: los campos Andreani sólo son evidencia logística si el pedido NO
// es Envío BEYONIX. Con A+B (sin C) se muestra el bloqueo falso que corrige C;
// Andreani moderno y legacy (shipping_provider NULL) no cambian.

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8")
const actor = "20000000-0000-4000-8000-000000000002"
const adminActor = "20000000-0000-4000-8000-000000000004"
const superAdmin = "20000000-0000-4000-8000-000000000003"
const customer = "10000000-0000-4000-8000-000000000001"
let requestNumber = 0
const key = () => `93000000-0000-4000-8000-${String(++requestNumber).padStart(12, "0")}`

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
const between = (file: string, start: string, end: string) => {
  const text = read(file)
  const from = text.indexOf(start)
  const to = text.indexOf(end, from)
  assert.ok(from >= 0 && to > from, `recorte de ${file}`)
  return text.slice(from, to)
}
// Definiciones vigentes de las RPC de cancelación que 20261023100000 modifica.
const CANCELLATION_FUNCTIONS = [
  between("supabase/migrations/20260916100000_block_cancellation_during_andreani_creation.sql",
    "create or replace function public.approve_order_claim_cancellation(", "revoke all on function public.approve_order_claim_cancellation"),
  between("supabase/migrations/20260916100000_block_cancellation_during_andreani_creation.sql",
    "create or replace function public.admin_cancel_order(", "revoke all on function public.admin_cancel_order"),
  between("supabase/migrations/20261014140000_automatic_cancellation_fiscal_refund.sql",
    "create or replace function public.begin_mercadopago_order_refund(", "revoke all on function public.begin_mercadopago_order_refund"),
]
const MIGRATION_A = "supabase/migrations/20261103120000_local_delivery_parcels_labels.sql"
const MIGRATION_B = "supabase/migrations/20261103130000_local_delivery_in_transit_parcels_guard.sql"
const MIGRATION_C = "supabase/migrations/20261104120000_local_delivery_change_guard_and_label_generation.sql"
type Stage = "AB" | "ABC"

async function setup(stage: Stage) {
  const db = new PGlite()
  for (const file of MIGRATIONS) {
    await db.exec(read(file))
    if (file.endsWith("dispatch-schema.sql")) await db.exec(read("lib/orders/fixtures/bundle-handover-orders.sql"))
    if (file.endsWith("dispatch-inventory-schema.sql")) await db.exec(read("lib/orders/fixtures/bundle-handover-finance.sql"))
  }
  for (const sql of CANCELLATION_FUNCTIONS) await db.exec(sql)
  await db.exec(read("supabase/migrations/20260917110000_fix_customer_cancellation_type_and_null_bugs.sql"))
  await db.exec(read("supabase/migrations/20261023100000_bundle_handover_cancellation_cutoff.sql"))
  await db.exec(read("supabase/migrations/20261023110000_super_admin_cancellation_financial_circuit.sql"))
  await db.exec("alter table ordenes add column if not exists admin_visible_at timestamptz, add column if not exists payment_confirmed_at timestamptz")
  await db.exec(read("supabase/migrations/20261023120000_return_inspection_money_decision.sql"))
  await db.exec(read(MIGRATION_A))
  await db.exec(read(MIGRATION_B))
  if (stage === "ABC") await db.exec(read(MIGRATION_C))
  await db.query("select set_config('request.jwt.claim.role','service_role',false)")
  await db.query("insert into profiles(id,rol) values ($1,'operador'),($2,'admin'),($3,'super_admin')", [actor, adminActor, superAdmin])
  await db.exec(`
    insert into productos(id,sku,codigo_barra,nombre) values (1,'SKU-A','BAR-A','Auriculares Pro');
    insert into producto_variantes(id,producto_id,sku,codigo_barra,nombre) values (12,1,'SKU-A-BLUE','BAR-A-BLUE','Azul');
    insert into catalog_sku_registry(normalized_sku,product_id,variant_id) values ('SKU-A',1,null),('SKU-A-BLUE',null,12);
    insert into product_cost_entries(product_id,variant_id,received_quantity) values (1,12,40);
  `)
  await db.query("select create_dispatch_batch($1,$2)", [actor, key()])
  return db
}

// QR final del Bulto: fecha, lote y operador van juntos (ordenes_handed_over_pair_check); lote 1 creado en setup.
const HANDED_OVER = { andreani_handed_over_at: "2026-11-01T09:00:00Z", andreani_handed_over_batch_id: "1", andreani_handed_over_by: actor }
/** Todo lo que puede quedar de un envío Andreani sobre un pedido (estado "En transito", tracking, QR, creación incierta). */
const RESIDUE = {
  andreani_envio_id: "ENV-RES", andreani_creation_status: "created", andreani_tracking: "360000009999", andreani_estado: "En transito",
  tracking_number: "TRK-RES", andreani_tracking_event_at: "2026-11-01T10:00:00Z", ...HANDED_OVER,
}
type OrderFields = Record<string, string | null>
let nextOrder = 3000
async function insertOrder(db: PGlite, fields: OrderFields) {
  const id = ++nextOrder
  const base: OrderFields = { andreani_envio_id: null, andreani_creation_status: null, andreani_tracking: null }
  const values = { ...base, ...fields }
  const columns = Object.keys(values)
  await db.query(`insert into ordenes(id,usuario_id,payment_id,${columns.join(",")}) values ($1,$2,$3,${columns.map((_, index) => `$${index + 4}`).join(",")})`,
    [id, customer, String(90000 + id), ...Object.values(values)])
  await db.query("insert into orden_items(id,orden_id,producto_id,variante_id,cantidad,precio) values ($1,$1,1,12,1,10000)", [id])
  await db.exec("select refresh_inventory_stock(1)")
  return id
}
const beyonix = (fields: OrderFields = {}) => ({ shipping_provider: "beyonix", ...RESIDUE, ...fields })
const andreani = (fields: OrderFields = {}) => ({ shipping_provider: "andreani", ...RESIDUE, ...fields })

const cutoffSql = async (db: PGlite, id: number) =>
  (await db.query<{ c: boolean }>("select order_dispatch_cutoff_reached(o) c from ordenes o where id=$1", [id])).rows[0].c
const reasons = async (db: PGlite, id: number) =>
  (await db.query<{ r: string[] }>("select dispatch_order_block_reasons($1) r", [id])).rows[0].r
const customerCancel = (db: PGlite, id: number) =>
  db.query<{ r: { estado: string } }>("select request_customer_order_cancellation_with_claim($1,$2,$3) r", [id, customer, "Ya no lo necesito, gracias"])
const adminCancel = (db: PGlite, id: number) =>
  db.query<{ estado: string }>("select (admin_cancel_order($1,$2,'admin','cancel','solicitud_cliente','El cliente pidió cancelar')).estado", [id, adminActor])

test("A/B/C: corte de despacho SQL = TS; Envío BEYONIX sólo por su estado, Andreani moderno/legacy sin cambios", async () => {
  const db = await setup("ABC")
  try {
    const cases: Array<[string, OrderFields, boolean]> = [
      ["A. BEYONIX + andreani_estado 'En transito'", { shipping_provider: "beyonix", andreani_estado: "En transito" }, false],
      ["B. BEYONIX + andreani_tracking residual (sin armado)", { shipping_provider: "beyonix", andreani_tracking: "360000009999", andreani_envio_id: "ENV-RES" }, false],
      ["BEYONIX + tracking_number residual", { shipping_provider: "beyonix", tracking_number: "TRK-RES" }, false],
      ["BEYONIX + QR final residual", { shipping_provider: "beyonix", ...HANDED_OVER }, false],
      ["BEYONIX con todos los residuos", beyonix(), false],
      ["BEYONIX legacy (shipping_provider NULL, envio_proveedor beyonix)", { shipping_provider: null, envio_proveedor: "beyonix", ...RESIDUE }, false],
      ["BEYONIX En camino (evidencia propia)", beyonix({ estado: "en_camino" }), true],
      ["BEYONIX Entregado", beyonix({ estado: "entregado" }), true],
      ["Andreani moderno con tracking manual", { shipping_provider: "andreani", tracking_number: "TRK-1" }, true],
      ["Andreani moderno en transporte", { shipping_provider: "andreani", andreani_estado: "En distribución" }, true],
      ["Andreani moderno QR final", { shipping_provider: "andreani", ...HANDED_OVER }, true],
      ["Andreani moderno entregado", { shipping_provider: "andreani", estado: "entregado" }, true],
      ["Andreani legacy (provider NULL) envío histórico sin armado", { shipping_provider: null, envio_proveedor: null, andreani_tracking: "360000000001", andreani_envio_id: "ENV-1" }, true],
      ["Andreani legacy envio_proveedor andreani en transporte", { shipping_provider: null, envio_proveedor: "andreani", andreani_estado: "En camino" }, true],
      ["Andreani sin envío todavía", { shipping_provider: "andreani" }, false],
    ]
    for (const [name, fields, expected] of cases) {
      const id = await insertOrder(db, fields)
      assert.equal(await cutoffSql(db, id), expected, `SQL: ${name}`)
      assert.equal(isOrderDispatchCutoffReached(fields as DispatchCutoffOrder, false), expected, `TS: ${name}`)
    }
  } finally { await db.close() }
})

test("sin C (A+B): el residuo Andreani hacía 'despachado' a un pedido BEYONIX Preparando (bloqueo falso que corrige C)", async () => {
  const db = await setup("AB")
  try {
    const id = await insertOrder(db, beyonix())
    assert.equal(await cutoffSql(db, id), true)
    assert.ok((await reasons(db, id)).includes("tracking_in_circuit"))
    await assert.rejects(customerCancel(db, id), /ORDER_ALREADY_DISPATCHED|ANDREANI_/)
  } finally { await db.close() }
})

test("C. dispatch_order_block_reasons: residuos Andreani no generan tracking_in_circuit/shipment_uncertain/already_handed_over en BEYONIX; Andreani igual", async () => {
  const db = await setup("ABC")
  try {
    const local = await insertOrder(db, beyonix({ andreani_creation_status: "reconciliation_required" }))
    const localReasons = await reasons(db, local)
    for (const reason of ["tracking_in_circuit", "shipment_uncertain", "already_handed_over"]) assert.equal(localReasons.includes(reason), false, reason)
    assert.ok(localReasons.includes("shipment_pending"), "nunca entra al circuito Andreani")
    assert.ok((await reasons(db, await insertOrder(db, beyonix({ estado: "en_camino" })))).includes("tracking_in_circuit"), "su propio En camino sí")
    const modern = await reasons(db, await insertOrder(db, andreani({ andreani_creation_status: "reconciliation_required" })))
    for (const reason of ["tracking_in_circuit", "shipment_uncertain", "already_handed_over"]) assert.ok(modern.includes(reason), `Andreani ${reason}`)
    const legacy = await reasons(db, await insertOrder(db, { shipping_provider: null, envio_proveedor: "andreani", andreani_envio_id: "ENV-L", andreani_creation_status: "created", tracking_number: "TRK-L" }))
    assert.ok(legacy.includes("tracking_in_circuit"), "Andreani legacy")
  } finally { await db.close() }
})

test("D. preparación BEYONIX con residuos: pickeo, bultos, etiqueta generada, BX-PKG confirmado y En camino", async () => {
  for (const stage of ["AB", "ABC"] as const) {
    const db = await setup(stage)
    try {
      const id = await insertOrder(db, beyonix())
      const flow = async () => {
        await db.query("select begin_order_preparation($1,$2)", [id, actor])
        await db.query("select scan_order_preparation_code($1,$2,$3,$4)", [id, "BAR-A-BLUE", actor, key()])
        await db.query("select set_order_package_parcels($1,1,$2,$3)", [id, actor, key()])
        const code = `BX-PKG-${1000 + id}-01`
        if (stage === "ABC") {
          const pkg = (await db.query<{ id: number }>("select id from order_packages where order_id=$1", [id])).rows[0]
          await db.query("select record_local_delivery_labels_generated($1,$2,$3,1,$4)", [id, actor, pkg.id, [code]])
        }
        await db.query("select confirm_local_delivery_parcel($1,$2,$3)", [id, code, actor])
        return (await db.query<{ id: number }>("select id from mark_local_delivery_in_transit($1,'pagado',$2)", [id, actor])).rows
      }
      if (stage === "AB") await assert.rejects(flow(), /DISPATCH_(ORDER_BLOCKED|ALREADY_HANDED_OVER)/, "sin C, el residuo bloqueaba")
      else assert.deepEqual(await flow(), [{ id }])
    } finally { await db.close() }
  }
})

test("E/F. cancelación cliente y Admin: BEYONIX con residuos (incluida creación Andreani 'claimed') se cancela; Andreani sigue bloqueado", async () => {
  const db = await setup("ABC")
  try {
    const local = await insertOrder(db, beyonix({ andreani_creation_status: "claimed" }))
    assert.equal((await customerCancel(db, local)).rows[0].r.estado, "cancelado")
    await assert.rejects(customerCancel(db, await insertOrder(db, beyonix({ estado: "en_camino" }))), /ORDER_ALREADY_DISPATCHED/, "su propio En camino sí corta")
    await assert.rejects(customerCancel(db, await insertOrder(db, andreani({ andreani_creation_status: "claimed" }))), /ANDREANI_CREATION_IN_PROGRESS/)
    await assert.rejects(customerCancel(db, await insertOrder(db, { shipping_provider: "andreani", tracking_number: "TRK-1" })), /ORDER_ALREADY_DISPATCHED/)
    await assert.rejects(customerCancel(db, await insertOrder(db, { shipping_provider: null, andreani_tracking: "360000000002", andreani_envio_id: "ENV-2" })), /ORDER_ALREADY_DISPATCHED/, "Andreani legacy")

    const notInvoiced = { invoice_status: null, invoice_cae: null }
    const adminLocal = await insertOrder(db, beyonix({ ...notInvoiced, andreani_creation_status: "reconciliation_required" }))
    assert.equal((await adminCancel(db, adminLocal)).rows[0].estado, "cancelado")
    await assert.rejects(adminCancel(db, await insertOrder(db, andreani({ ...notInvoiced, andreani_creation_status: "created" }))), /ORDER_ALREADY_DISPATCHED/)
    await assert.rejects(adminCancel(db, await insertOrder(db, andreani({ ...notInvoiced, andreani_creation_status: "reconciliation_required" }))), /ANDREANI_RECONCILIATION_REQUIRED/)
  } finally { await db.close() }
})

test("G. reintegro: un BEYONIX cancelado con residuos no exige devolución física; Andreani despachado sí", async () => {
  for (const stage of ["AB", "ABC"] as const) {
    const db = await setup(stage)
    try {
      const reserve = (id: number) => db.query("select (reserve_order_financial_resolution($1,$2,'beyonix_credit')).choice", [id, adminActor])
      const cancelled = { estado: "cancelado", financial_status: "refund_pending", cancelled_at: "2026-11-02T10:00:00Z" }
      const local = await insertOrder(db, beyonix(cancelled))
      if (stage === "AB") await assert.rejects(reserve(local), /FINANCIAL_RETURN_INSPECTION_REQUIRED/, "sin C, bloqueo falso")
      else assert.equal((await reserve(local)).rows.length, 1)
      await assert.rejects(reserve(await insertOrder(db, andreani(cancelled))), /FINANCIAL_RETURN_INSPECTION_REQUIRED/, `${stage}: Andreani igual`)
    } finally { await db.close() }
  }
})

test("Super Admin: la retención por 'despachado' no usa el QR final residual de un pedido BEYONIX; Andreani igual", async () => {
  const db = await setup("ABC")
  try {
    const retained = async (fields: OrderFields) => {
      const id = await insertOrder(db, fields)
      await db.query("select super_admin_cancel_order($1,$2,$3,$4)", [id, superAdmin, "error_administrativo", "Error en la carga del pedido"])
      return (await db.query<{ at: string | null }>("select super_admin_stock_retained_at at from ordenes where id=$1", [id])).rows[0].at
    }
    assert.equal(await retained(beyonix()), null)
    assert.notEqual(await retained(andreani()), null)
  } finally { await db.close() }
})

test("migración C: guardas reemplazadas exactamente una vez, re-ejecutable sin cambios y RPC con la misma firma", async () => {
  const db = await setup("ABC")
  try {
    const definition = async (signature: string) =>
      (await db.query<{ d: string }>("select pg_get_functiondef($1::regprocedure) d", [signature])).rows[0].d
    const signatures = [
      "public.request_customer_order_cancellation_with_claim(bigint,uuid,text)",
      "public.admin_cancel_order(bigint,uuid,text,text,text,text)",
      "public.approve_order_claim_cancellation(bigint,uuid,text,text)",
    ]
    for (const signature of signatures) {
      const text = await definition(signature)
      assert.equal(text.split("andreani_creation_status = 'claimed' and not public.order_is_local_delivery(v_order) then").length, 2, signature)
      assert.equal(text.split("andreani_creation_status = 'reconciliation_required' and not public.order_is_local_delivery(v_order) then").length, 2, signature)
    }
    assert.match(await definition("public.set_order_package_parcels(bigint,integer,uuid,uuid)"), /andreani_handed_over_at is not null and not public\.order_is_local_delivery\(ordenes\)\) then/)
    assert.match(await definition("public.reset_order_preparation(bigint,uuid,uuid,text)"), /andreani_handed_over_at is not null and not public\.order_is_local_delivery\(ordenes\)\) then/)
    assert.match(await definition("public.super_admin_cancel_order(bigint,uuid,text,text)"), /v_dispatched := \(v_order\.andreani_handed_over_at is not null and not public\.order_is_local_delivery\(v_order\)\)/)
    const before = await Promise.all(signatures.map(definition))
    await db.exec(read(MIGRATION_C))
    assert.deepEqual(await Promise.all(signatures.map(definition)), before, "re-ejecutar C no cambia nada")
  } finally { await db.close() }
})
