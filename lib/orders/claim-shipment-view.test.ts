import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { getAdminClaimWizard } from "./admin-claim-wizard.ts"
import {
  CLAIM_RETURN_PACKING_INSTRUCTIONS,
  CUSTOMER_CLAIM_SHIPMENT_COLUMNS,
  canCloseClaimLogistics,
  getAdminClaimLogisticsView,
  getCustomerClaimShipmentView,
  pickCurrentClaimShipment,
  type ClaimShipmentAdminSource,
  type ClaimUnitSource,
} from "./claim-shipment-view.ts"

// Logística del reclamo (sólo sucursal, método elegido por el Admin): qué ve
// el cliente, qué ve y puede hacer Admin, y dónde se exigen permisos.

const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n")

const leg = (overrides: Partial<ClaimShipmentAdminSource> = {}): ClaimShipmentAdminSource => ({
  id: 1, direction: "cambio", attempt: 1, status: "pendiente", creation_status: "not_started", closed_at: null,
  branch_id: "4567", branch_name: "Sucursal Once", ...overrides,
})
let unitId = 0
const unit = (role: "original" | "reemplazo", location: ClaimUnitSource["location"], overrides: Partial<ClaimUnitSource> = {}): ClaimUnitSource => ({
  id: ++unitId, order_item_id: 70, role, location, shipment_id: null, incident_open: false, ...overrides,
})

test("cliente, CAMBIO: sucursal, qué preparar y qué pasa si no entrega el original; nunca domicilio ni datos internos", () => {
  const generated = getCustomerClaimShipmentView({
    direction: "cambio", status: "generada", modality: "cambio_sucursal", andreani_tracking: " 360000012345678 ",
    branch_name: "Sucursal Once", branch_address: "Av. Pueyrredón 100",
    ...({ cost_amount: 4500, creation_error: "HTTP 500 interno", contract: "400042110", environment: "PROD", branch_id: "4567" } as object),
  })
  assert.equal(generated?.branchLabel, "Sucursal Once · Av. Pueyrredón 100")
  assert.equal(generated?.instructions[0], CLAIM_RETURN_PACKING_INSTRUCTIONS)
  assert.match(generated?.instructions[1] ?? "", /Sucursal Once/)
  assert.match(generated?.instructions.join(" ") ?? "", /Si no se entrega el producto original, Andreani no entrega el nuevo/)
  assert.equal(generated?.label, false, "el cambio nunca ofrece etiqueta al cliente")
  assert.doesNotMatch(JSON.stringify(generated), /4500|HTTP 500|4000421|contrato|\bPROD\b|\bQA\b|domicilio|\b4567\b/i)

  const branch = getCustomerClaimShipmentView({ direction: "cambio", status: "en_sucursal", modality: "cambio_sucursal" })
  assert.equal(branch?.statusLabel, "Disponible temporalmente en sucursal Andreani")
  assert.doesNotMatch(JSON.stringify(branch), /\d+ días|vence/, "sin inventar el plazo de la sucursal")
  assert.equal(getCustomerClaimShipmentView({ direction: "cambio", status: "en_sucursal", exchange_outcome: "no_completado" })?.statusLabel, "Cambio no completado")
  assert.equal(getCustomerClaimShipmentView({ direction: "cambio", status: "cancelada" }), null)
})

test("cliente, RETIRO y REENVÍO: etiqueta sólo de la devolución generada; reenvío a retirar en sucursal", () => {
  const dropoff = getCustomerClaimShipmentView({ direction: "devolucion", status: "generada", modality: "despacho_sucursal", branch_name: "Sucursal Once" })
  assert.equal(dropoff?.label, true)
  assert.match(dropoff?.instructions[1] ?? "", /llevalo a Sucursal Once/)
  assert.equal(getCustomerClaimShipmentView({ direction: "devolucion", status: "pendiente" })?.label, false)
  assert.equal(getCustomerClaimShipmentView({ direction: "devolucion", status: "entregada" })?.label, false)
  const resend = getCustomerClaimShipmentView({ direction: "reemplazo", status: "en_sucursal", modality: "entrega_sucursal", branch_name: "Sucursal Once" })
  assert.match(resend?.instructions[0] ?? "", /Retiralo en Sucursal Once/)
  assert.equal(resend?.label, false)
  const all = ["cambio", "devolucion", "reemplazo"].flatMap((direction) =>
    ["pendiente", "generada", "en_transito", "en_sucursal", "entregada"].map((status) =>
      JSON.stringify(getCustomerClaimShipmentView({ direction: direction as never, status: status as never }))))
  assert.doesNotMatch(all.join(" "), /domicilio/i, "el cliente nunca ve la opción domicilio")
})

test("tramo vigente: el abierto; si no hay, el último intento (nunca uno cancelado)", () => {
  const rows = [leg({ id: 1, status: "entregada", closed_at: "x" }), leg({ id: 2, status: "cancelada", closed_at: "y" }), leg({ id: 3, direction: "devolucion" })]
  assert.equal(pickCurrentClaimShipment(rows)?.id, 3)
  assert.equal(pickCurrentClaimShipment(rows.slice(0, 2))?.id, 1)
})

test("Admin: sin método elegido ofrece los dos (cambio) o el retiro (reintegro); nada automático", () => {
  const change = getAdminClaimLogisticsView({ status: "aprobado", resolution: "cambio_producto", shipments: [], units: [] })
  assert.equal(change?.plan, null)
  assert.deepEqual(change?.methodOptions.map((option) => option.direction), ["cambio", "devolucion"])
  assert.match(change?.methodOptions[0].label ?? "", /Cambio directo por sucursal/)
  assert.match(change?.methodOptions[1].label ?? "", /Retiro \+ revisión \+ reenvío/)
  assert.ok(change?.methodOptions.every((option) => option.description.length > 20))
  assert.match(change?.nextStep ?? "", /Elegí el método logístico/)
  assert.equal(change?.canAuthorizeResend, false)
  const refund = getAdminClaimLogisticsView({ status: "reintegro_pendiente", resolution: "reintegro_total", shipments: [], units: [] })
  assert.deepEqual(refund?.methodOptions.map((option) => option.direction), ["devolucion"])
  assert.equal(getAdminClaimLogisticsView({ status: "en_revision", resolution: null, shipments: [], units: [] }), null)
})

test("Admin, CAMBIO DIRECTO: reserva -> generar -> custodia -> no completado; el método no se cambia en curso", () => {
  const originals = [unit("original", "con_cliente"), unit("original", "con_cliente")]
  const view = getAdminClaimLogisticsView({ status: "aprobado", resolution: "cambio_producto", shipments: [leg()], units: originals })
  assert.equal(view?.plan, "cambio_directo")
  assert.match(view?.nextStep ?? "", /Reservá el producto de reemplazo \(2 unidades\)/)
  assert.equal(view?.wizardStep, "replacement")
  assert.deepEqual(view?.methodOptions.map((option) => option.direction), ["devolucion"], "antes de Andreani se puede cambiar de método")
  assert.equal(view?.methodChangeRequiresReason, false)

  const inTransit = getAdminClaimLogisticsView({
    status: "aprobado", resolution: "cambio_producto",
    shipments: [leg({ status: "en_sucursal", creation_status: "created", modality: "cambio_sucursal" })],
    units: [...originals.map((row) => ({ ...row, shipment_id: 1 })), unit("reemplazo", "en_andreani", { shipment_id: 1 })],
  })
  assert.equal(inTransit?.leg?.canMarkNotCompleted, true)
  assert.equal(inTransit?.leg?.canCancel, false)
  assert.deepEqual(inTransit?.methodOptions, [], "con la operación en curso no se cambia de método")
  assert.match(inTransit?.leg?.branchLabel ?? "", /Sucursal 4567 · Sucursal Once/)

  const failed = getAdminClaimLogisticsView({
    status: "aprobado", resolution: "cambio_producto",
    shipments: [leg({ status: "en_sucursal", creation_status: "created", exchange_outcome: "no_completado", closed_at: "x" })],
    units: [...originals, unit("reemplazo", "reincorporada_stock", { shipment_id: 1 })],
  })
  assert.equal(failed?.canRetryExchange, true)
  assert.deepEqual(failed?.methodOptions.map((option) => option.direction), ["devolucion"])
  assert.equal(failed?.methodChangeRequiresReason, true, "hubo operación real: cambiar de método exige motivo")
})

test("Admin, RETIRO + REVISIÓN + REENVÍO: nada sale antes de la inspección; incidencia bloquea; reenvío sólo autorizado", () => {
  const returning = leg({ direction: "devolucion", status: "entregada", creation_status: "created", closed_at: "x", modality: "despacho_sucursal" })
  const pendingInspection = getAdminClaimLogisticsView({
    status: "aprobado", resolution: "cambio_producto", shipments: [returning], units: [unit("original", "recibida_beyonix", { shipment_id: 1 })],
  })
  assert.equal(pendingInspection?.plan, "retiro_y_reenvio")
  assert.equal(pendingInspection?.canAuthorizeResend, false)
  assert.match(pendingInspection?.nextStep ?? "", /pendiente de inspección/)
  assert.equal(pendingInspection?.wizardStep, "reception")

  const withIncident = getAdminClaimLogisticsView({
    status: "aprobado", resolution: "cambio_producto", shipments: [returning],
    units: [unit("original", "baja", { shipment_id: 1, incident_open: true, incident_type: "paquete_vacio", incident_note: "Vacío" })],
  })
  assert.equal(withIncident?.canAuthorizeResend, false)
  assert.equal(withIncident?.items[0].incident, "Paquete vacío")
  assert.match(withIncident?.nextStep ?? "", /nada se reenvía, reintegra ni cierra/)
  assert.ok(withIncident?.unitActions.some((option) => option.action === "incident_resolve" && option.noteMin === 10))

  const inspected = getAdminClaimLogisticsView({
    status: "aprobado", resolution: "cambio_producto", shipments: [returning], units: [unit("original", "baja", { shipment_id: 1 })],
  })
  assert.equal(inspected?.canAuthorizeResend, true)
  assert.match(inspected?.nextStep ?? "", /autorizá el reemplazo/)
  const authorized = getAdminClaimLogisticsView({
    status: "aprobado", resolution: "cambio_producto",
    shipments: [returning, leg({ id: 2, direction: "reemplazo" })], units: [unit("original", "baja", { shipment_id: 1 })],
  })
  assert.match(authorized?.nextStep ?? "", /reservá el producto \(una sola vez\)/)
  assert.equal(authorized?.wizardStep, "replacement")
})

test("Admin: cierre sólo con todo resuelto; nunca original con el cliente + reemplazo entregado", () => {
  const settled = [unit("original", "reincorporada_stock"), unit("reemplazo", "entregada_cliente", { shipment_id: 1 })]
  assert.equal(canCloseClaimLogistics([leg({ status: "entregada", creation_status: "created", closed_at: "x" })], settled), true)
  assert.equal(canCloseClaimLogistics([], [unit("original", "con_cliente"), unit("reemplazo", "entregada_cliente")]), false)
  assert.equal(canCloseClaimLogistics([], [unit("original", "recibida_beyonix")]), false, "sin inspección")
  assert.equal(canCloseClaimLogistics([], [unit("original", "baja", { incident_open: true })]), false)
  assert.equal(canCloseClaimLogistics([leg({ creation_status: "manual_review" })], []), false)
})

test("wizard: el orden de pasos sigue el método elegido", () => {
  const exchange = getAdminClaimWizard({ status: "aprobado", resolution: "cambio_producto", receivedUnits: 0, replacedUnits: 0, logistics: { plan: "cambio_directo", step: "replacement" } })
  assert.deepEqual(exchange.steps.map((step) => step.key), ["review", "replacement", "execution", "reception", "finish"])
  const resend = getAdminClaimWizard({ status: "aprobado", resolution: "cambio_producto", receivedUnits: 0, replacedUnits: 0, logistics: { plan: "retiro_y_reenvio", step: "reception" } })
  assert.deepEqual(resend.steps.map((step) => step.label), ["Revisión", "Retiro e inspección", "Reemplazo autorizado", "Envío a sucursal", "Finalización"])
  const legacy = getAdminClaimWizard({ status: "aprobado", resolution: "cambio_producto", receivedUnits: 0, replacedUnits: 0 })
  assert.equal(legacy.current, "reception", "reclamos históricos sin logística: sin cambios")
})

test("seguridad: cliente sólo campos seguros; la sucursal se verifica en el servidor; contrato/ambiente/modalidad nunca del navegador", () => {
  assert.doesNotMatch(CUSTOMER_CLAIM_SHIPMENT_COLUMNS, /contract|environment|cost|error|envio_id|estado|branch_id/)
  assert.match(read("lib/orders/claim-server.ts"), /getClaimResult\(admin, claimId, "customer"\)/)
  const customer = read("app/api/orders/[id]/claims/[claimId]/return-label/route.ts")
  assert.match(customer, /await authorizeCustomerClaimOrder\(id\)/)
  assert.match(customer, /\.eq\("direction", "devolucion"\)/)
  const admin = read("app/api/admin/order-claims/[claimId]/andreani-shipment/route.ts")
  assert.equal(admin.match(/const auth = await requireAdmin\(request\)/g)?.length, 2)
  assert.match(admin, /shipment\.claim_id !== claimId/)
  assert.match(admin, /resolveClaimBranch\(body\.branchId\)/, "sucursal revalidada contra el catálogo en el servidor")
  assert.match(admin, /p_branch_name: branch\.name/, "nombre desde el catálogo, nunca del navegador")
  assert.doesNotMatch(admin, /body\.(contract|contrato|environment|modality|branchName|branchAddress)/)
})

test("sin automatismos: aceptar, reservar stock o el cron nunca generan operaciones; reintegro cruzado con inspección e incidencias", () => {
  assert.doesNotMatch(read("app/api/admin/pedidos/[id]/replacements/route.ts"), /createClaimShipment|claim-shipments/)
  assert.doesNotMatch(read("app/api/admin/order-claims/[claimId]/route.ts"), /createClaimShipment|request_order_claim_logistics/)
  // 20260928100000 es histórica (ya aplicada); la corrección vive en 20260930100000.
  const migration = read("supabase/migrations/20260930100000_claim_logistics_branch_only.sql")
  const trigger = migration.slice(migration.indexOf("function public.order_claim_change_accepted()"), migration.indexOf("drop trigger if exists zz_order_claim_change_accepted"))
  assert.doesNotMatch(trigger, /open_order_claim_leg|order_claim_shipments/, "aceptar un reclamo sólo deja mensajes")
  const modality = migration.slice(migration.indexOf("add constraint order_claim_shipments_modality"), migration.indexOf("add constraint order_claim_shipments_outcome_only_exchange"))
  assert.match(modality, /legacy and \(\(direction = 'devolucion' and modality = 'retiro_domicilio'\)/, "domicilio sólo en filas heredadas")
  assert.doesNotMatch(migration.slice(migration.indexOf("-- 4. Utilidades")), /'(retiro|cambio|entrega)_domicilio'/, "ninguna función nueva usa domicilio")
  assert.match(migration, /drop function if exists public\.claim_order_claim_shipment_creation\(bigint, text, uuid, text, text, text\)/)
  const lib = read("lib/andreani/claim-shipments.ts")
  assert.doesNotMatch(lib, /HOME_CONTRACT|RETURN_PICKUP|domicilioContrato|"create_order_replacement"|adjust_variant_stock/)
  assert.match(read("app/api/cron/andreani-sync-tracking/route.ts"), /runClaimShipmentTrackingBatch\(admin\)/)
  // NC/reintegro: guardas en la BASE (la ruta sólo registra la excepción explícita).
  const creditNote = read("app/api/admin/orders/[id]/credit-note/route.ts")
  assert.match(creditNote, /rpc\("register_claim_financial_exception"/)
  assert.doesNotMatch(creditNote, /\.from\("order_claim_units"\)/, "sin lógica duplicada en TS")
  assert.match(migration, /before insert on public\.order_credit_notes/)
  assert.match(migration, /before insert on public\.order_refund_proofs/)
})

test("Admin: resumen simple (método, sucursal, Andreani, inspección, incidencias, intervención) + revisión y legacy", () => {
  const review = getAdminClaimLogisticsView({
    status: "aprobado", resolution: "cambio_producto",
    shipments: [leg({ status: "en_transito", creation_status: "created", modality: "cambio_sucursal", review_required: true, review_event: "EnvioAnulado", andreani_estado: "En viaje" })],
    units: [unit("original", "con_cliente", { shipment_id: 1 }), unit("reemplazo", "en_andreani", { shipment_id: 1 })],
  })
  assert.deepEqual(review?.summary, {
    method: "Cambio directo por sucursal", branch: "Sucursal 4567 · Sucursal Once", andreani: "En tránsito · En viaje",
    inspection: "Pendiente", incidents: 1, manualIntervention: true,
  })
  assert.match(review?.nextStep ?? "", /no podemos clasificar \(EnvioAnulado\).*congelado/)
  assert.equal(review?.leg?.canResolveReview, true)
  assert.equal(review?.canRetryExchange, false)
  const legacy = getAdminClaimLogisticsView({ status: "aprobado", resolution: "cambio_producto", shipments: [], units: [], legacy: true })
  assert.equal(legacy?.legacy, true)
  assert.equal(legacy?.summary.method, "Flujo anterior (legacy)")
  assert.match(legacy?.nextStep ?? "", /anterior al circuito por sucursal/)
})

test("cliente: en sucursal con la fecha REAL de Andreani, sin countdown; sin fecha, sólo 'en sucursal'", () => {
  const withDate = getCustomerClaimShipmentView({ direction: "cambio", status: "en_sucursal", branch_custody_since: "2026-09-28T15:00:00Z" })
  assert.equal(withDate?.statusLabel, "Disponible temporalmente en sucursal Andreani desde el 28/09/2026")
  assert.doesNotMatch(JSON.stringify(withDate), /vence|restan|quedan \d|días/i)
  assert.equal(getCustomerClaimShipmentView({ direction: "cambio", status: "en_sucursal" })?.statusLabel, "Disponible temporalmente en sucursal Andreani")
})

test("seguridad: rutas del cliente no aceptan sucursal/contrato/ambiente/modalidad/costo; buscador de sucursales sólo Admin", () => {
  const customerClaims = read("app/api/orders/[id]/claims/route.ts")
  const allowed = customerClaims.match(/const allowedFields = new Set\(\[(.*?)\]\)/)?.[1] ?? ""
  assert.ok(allowed.length > 0)
  assert.doesNotMatch(allowed, /branch|contract|contrato|environment|ambiente|modality|cost|shipment/i)
  assert.doesNotMatch(read("app/api/orders/[id]/claims/[claimId]/return-label/route.ts"), /request\.json|searchParams/)
  const branches = read("app/api/admin/order-claims/[claimId]/andreani-branches/route.ts")
  assert.match(branches, /const auth = await requireAdmin\(request\)/)
  assert.match(branches, /"Cache-Control": "private, no-store"/)
  const lib = read("lib/andreani/claim-shipments.ts")
  assert.match(lib, /console\.error\("ANDREANI_CLAIM_BRANCH_CATALOG_ERROR", normalizeAndreaniError\(error, env\)\)/, "logs sanitizados")
  assert.doesNotMatch(lib, /console\.(log|error)\([^)]*(token|password|Authorization)/i)
})

test("UI: método explícito con confirmación, sucursal del catálogo, doble click protegido; cliente sin opción domicilio", () => {
  const panel = read("components/claims/claim-andreani-shipment-panel.tsx")
  assert.match(panel, /if \(inFlightRef\.current\) return null/)
  assert.match(panel, /getOrCreateIdempotencyAttempt\(unitAttemptRef\.current/)
  assert.match(panel, /if \(!requestConfirming\) \{/, "el método se confirma explícitamente")
  assert.match(panel, /andreani-branches\?/, "sucursal elegida del buscador, no tipeada")
  assert.doesNotMatch(panel, /idgla\)/, "el Admin no escribe el idgla")
  assert.match(panel, /disabled=\{pending !== null \|\| !selectedBranch/, "sin sucursal válida no hay logística")
  assert.match(read("components/claims/admin-claim-manager.tsx"), /\["reception", "replacement", "execution"\]\.includes\(selectedStep\) && logisticsPanel/)
  const customer = read("components/claims/customer-claim-shipments-notice.tsx")
  assert.doesNotMatch(customer, /domicilio/i)
  assert.match(customer, /\/api\/orders\/\$\{claim\.order_id\}\/claims\/\$\{claim\.id\}\/return-label/)
})
