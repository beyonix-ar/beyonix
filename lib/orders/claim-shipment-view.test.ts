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
  assert.equal(view?.wizardStep, "logistics", "reserva y generación viven en el paso del cambio en sucursal")
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
  assert.equal(failed?.wizardStep, "logistics", "cambio no completado y producto nuevo ya revisado: se reintenta en el paso del cambio")
  assert.equal(inTransit?.wizardStep, "logistics")

  // El cambio se completó: el original vuelve y se recibe en su propio paso; después, Finalización.
  const returning = getAdminClaimLogisticsView({
    status: "aprobado", resolution: "cambio_producto",
    shipments: [leg({ status: "entregada", creation_status: "created", exchange_outcome: "completado", closed_at: "x" })],
    units: [unit("original", "en_andreani", { shipment_id: 1 }), unit("reemplazo", "entregada_cliente", { shipment_id: 1 })],
  })
  assert.equal(returning?.wizardStep, "reception")
  const done = getAdminClaimLogisticsView({
    status: "aprobado", resolution: "cambio_producto",
    shipments: [leg({ status: "entregada", creation_status: "created", exchange_outcome: "completado", closed_at: "x" })],
    units: [unit("original", "reincorporada_stock", { shipment_id: 1 }), unit("reemplazo", "entregada_cliente", { shipment_id: 1 })],
  })
  assert.equal(done?.wizardStep, "finish")
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

test("wizard: un paso por concepto, en el orden real del método elegido", () => {
  const exchange = getAdminClaimWizard({ status: "aprobado", resolution: "cambio_producto", receivedUnits: 0, replacedUnits: 0, logistics: { plan: "cambio_directo", step: "logistics" } })
  assert.deepEqual(exchange.steps.map((step) => step.label), ["Revisión", "Método", "Cambio en sucursal", "Recepción", "Finalización"])
  const resend = getAdminClaimWizard({ status: "aprobado", resolution: "cambio_producto", receivedUnits: 0, replacedUnits: 0, logistics: { plan: "retiro_y_reenvio", step: "reception" } })
  assert.deepEqual(resend.steps.map((step) => step.label), ["Revisión", "Método", "Retiro", "Recepción", "Reenvío", "Finalización"])
  assert.equal(resend.current, "reception")
  const refundDone = getAdminClaimWizard({ status: "reintegro_pendiente", resolution: "reintegro_total", receivedUnits: 0, replacedUnits: null, logistics: { plan: "retiro", step: "execution" } })
  assert.deepEqual(refundDone.steps.map((step) => step.label), ["Revisión", "Método", "Retiro", "Recepción", "Reintegro", "Finalización"])
  assert.equal(refundDone.current, "execution")
  const resolved = getAdminClaimWizard({ status: "aprobado", resolution: "cambio_producto", receivedUnits: 1, replacedUnits: 1, logistics: { plan: "cambio_directo", step: "finish" } })
  assert.equal(resolved.current, "finish", "logística resuelta: sólo queda finalizar")
  const legacy = getAdminClaimWizard({ status: "aprobado", resolution: "cambio_producto", receivedUnits: 0, replacedUnits: 0 })
  assert.equal(legacy.current, "reception", "reclamos históricos sin logística: sin cambios")
})

test("wizard: sin método el paso vigente es 'Método'; con método, el paso anterior al primero operativo es 'Método'", () => {
  const pending = getAdminClaimWizard({ status: "aprobado", resolution: "cambio_producto", receivedUnits: 0, replacedUnits: null, logistics: { plan: null, step: "logistics" } })
  assert.deepEqual(pending.steps.map((step) => step.key), ["review", "method", "finish"])
  assert.equal(pending.current, "method")
  assert.equal(pending.steps[pending.currentIndex - 1].key, "review", "desde Método, volver lleva a Revisión")
  const chosen = getAdminClaimWizard({ status: "aprobado", resolution: "cambio_producto", receivedUnits: 0, replacedUnits: 0, logistics: { plan: "cambio_directo", step: "logistics" } })
  assert.equal(chosen.steps[chosen.currentIndex - 1].key, "method", "volver al paso anterior lleva a revisar el método")
  const refund = getAdminClaimWizard({ status: "reintegro_pendiente", resolution: "reintegro_total", receivedUnits: 0, replacedUnits: null, logistics: { plan: "retiro", step: "reception" } })
  assert.deepEqual(refund.steps.map((step) => step.key), ["review", "method", "logistics", "reception", "execution", "finish"])
  const closed = getAdminClaimWizard({ status: "cerrado", resolution: "cambio_producto", receivedUnits: 0, replacedUnits: null, logistics: { plan: null, step: "logistics" } })
  assert.equal(closed.current, "finish")
})

test("Admin: corregir el método sólo sin efectos reales; con efectos se muestran y se bloquea (o exige motivo)", () => {
  const originals = [unit("original", "con_cliente")]
  const free = getAdminClaimLogisticsView({ status: "aprobado", resolution: "cambio_producto", shipments: [leg()], units: originals })
  assert.deepEqual(free?.methodLock, { status: "free", effects: [], correction: null })
  assert.deepEqual(free?.methodChoices.map((choice) => [choice.direction, choice.current, choice.available]),
    [["cambio", true, false], ["devolucion", false, true]])
  assert.match(free?.methodChoices[0].description ?? "", /solo si el cliente entrega el producto original/)

  const reserved = getAdminClaimLogisticsView({ status: "aprobado", resolution: "cambio_producto", shipments: [leg()], units: [...originals, unit("reemplazo", "reservada")] })
  assert.deepEqual(reserved?.methodOptions, [], "stock reservado: no se cambia de método sin liberar la reserva")
  assert.equal(reserved?.methodLock.status, "blocked")
  assert.deepEqual(reserved?.methodLock.effects, ["Stock reservado para el reemplazo: 1 unidad"])
  assert.match(reserved?.methodLock.correction ?? "", /liberá la reserva del reemplazo con un motivo/)
  assert.ok(reserved?.unitActions.some((option) => option.action === "release_reservation" && option.noteMin === 10), "corrección auditada disponible")

  const generated = getAdminClaimLogisticsView({
    status: "aprobado", resolution: "cambio_producto",
    shipments: [leg({ status: "generada", creation_status: "created", andreani_tracking: "360000000801" })],
    units: [unit("original", "con_cliente", { shipment_id: 1 }), unit("reemplazo", "reservada", { shipment_id: 1 })],
  })
  assert.equal(generated?.methodLock.status, "blocked")
  assert.match(generated?.methodLock.effects.join(" | ") ?? "", /Operación generada: Cambio en sucursal Andreani \(360000000801\)/)
  assert.match(generated?.methodLock.correction ?? "", /primero cancelá la operación Andreani con un motivo/)

  const moving = getAdminClaimLogisticsView({
    status: "aprobado", resolution: "cambio_producto",
    shipments: [leg({ direction: "devolucion", status: "en_transito", creation_status: "created" })],
    units: [unit("original", "en_andreani", { shipment_id: 1 })],
  })
  assert.equal(moving?.methodLock.status, "blocked")
  assert.match(moving?.methodLock.effects.join(" | ") ?? "", /Producto original en viaje con Andreani: 1 unidad/)
  assert.match(moving?.methodLock.correction ?? "", /ya está en curso/)

  const failed = getAdminClaimLogisticsView({
    status: "aprobado", resolution: "cambio_producto",
    shipments: [leg({ status: "en_sucursal", creation_status: "created", exchange_outcome: "no_completado", closed_at: "x" })],
    units: [...originals, unit("reemplazo", "reincorporada_stock", { shipment_id: 1 })],
  })
  assert.equal(failed?.methodLock.status, "reason", "operación real previa: corrección con motivo y auditoría")

  const withCreditNote = getAdminClaimLogisticsView({
    status: "reintegro_pendiente", resolution: "reintegro_total", creditNoteActive: true,
    shipments: [leg({ direction: "devolucion" })], units: originals,
  })
  assert.equal(withCreditNote?.methodLock.status, "blocked")
  assert.match(withCreditNote?.methodLock.effects.join(" | ") ?? "", /Nota de crédito emitida o en proceso/)

  const noPlan = getAdminClaimLogisticsView({ status: "aprobado", resolution: "cambio_producto", shipments: [], units: originals })
  assert.deepEqual(noPlan?.methodChoices.map((choice) => [choice.direction, choice.current, choice.available]),
    [["cambio", false, true], ["devolucion", false, true]])
})

test("servidor: cambiar de método con stock reservado o nota de crédito vigente se rechaza antes del RPC", () => {
  const route = read("app/api/admin/order-claims/[claimId]/andreani-shipment/route.ts")
  const request = route.slice(route.indexOf('if (action === "request")'), route.indexOf("if ((LEG_ACTIONS"))
  assert.ok(request.indexOf("getMethodChangeBlock(") < request.indexOf('rpc("request_order_claim_logistics"'))
  const guard = route.slice(route.indexOf("async function getMethodChangeBlock"), route.indexOf("export async function POST"))
  assert.match(guard, /\.eq\("role", "reemplazo"\)\.eq\("location", "reservada"\)/)
  assert.match(guard, /\.from\("order_credit_notes"\)/)
  assert.match(guard, /status: 500/, "si no se puede verificar, falla cerrado")
  // La autoridad final es la base (claim-logistics-method-race.test.mjs lo prueba con dos backends).
  const sql = read("supabase/migrations/20261001100000_claim_logistics_hardening.sql")
  const rpc = sql.slice(sql.indexOf("create or replace function public.request_order_claim_logistics("), sql.indexOf("create or replace function public.cancel_order_claim_leg("))
  assert.ok(rpc.indexOf("for update") < rpc.indexOf("raise exception 'CLAIM_LOGISTICS_RESERVATION_ACTIVE'"))
  assert.match(rpc, /raise exception 'CLAIM_LOGISTICS_CREDIT_NOTE_ACTIVE'/)
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
  // 20260928100000 y 20260930100000 son históricas (ya aplicadas); el endurecimiento vive en 20261001100000.
  const migration = read("supabase/migrations/20261001100000_claim_logistics_hardening.sql")
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
  assert.match(panel, /if \(reasonRequired && !requestConfirming\) \{/, "corregir con operación previa pide segunda confirmación")
  assert.match(panel, /type="radio"/, "método como radios accesibles")
  assert.match(panel, /andreani-branches\?/, "sucursal elegida del buscador, no tipeada")
  assert.doesNotMatch(panel, /idgla\)/, "el Admin no escribe el idgla")
  assert.match(panel, /disabled=\{pending !== null \|\| !selectedBranch/, "sin sucursal válida no hay logística")
  const manager = read("components/claims/admin-claim-manager.tsx")
  assert.match(manager, /selectedStep === "method" && renderLogisticsPanel\("method"\)/)
  assert.match(manager, /\(selectedStep === "logistics" \|\| selectedStep === "reception" \|\| selectedStep === "replacement"\) && renderLogisticsPanel\(selectedStep\)/,
    "cada paso operativo muestra sólo su parte de la logística")
  assert.doesNotMatch(panel, /Elegí una acción…|Recepción e inspección de unidades/, "sin el desplegable genérico de acciones")
  assert.doesNotMatch(panel, /modalityLabel/, "sin datos internos de contrato en pantalla")
  const customer = read("components/claims/customer-claim-shipments-notice.tsx")
  assert.doesNotMatch(customer, /domicilio/i)
  assert.match(customer, /\/api\/orders\/\$\{claim\.order_id\}\/claims\/\$\{claim\.id\}\/return-label/)
})
