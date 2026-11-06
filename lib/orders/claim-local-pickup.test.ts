import assert from "node:assert/strict"
import test from "node:test"

import { getAdminClaimWizard } from "./admin-claim-wizard.ts"
import { getCustomerLocalPickupView, type ClaimLocalPickupSource } from "./claim-local-pickup.ts"
import { getAdminClaimLogisticsView, getCustomerClaimHeadline, type ClaimUnitSource } from "./claim-shipment-view.ts"
import { getCustomerClaimSummary } from "./customer-claim-experience.ts"

// Envío BEYONIX: devolución por retiro de cadete dentro del mismo reclamo.
// Las reglas reales viven en la base (claim-local-pickups-sql.test.ts); acá,
// lo que ven Admin y el cliente en cada estado.

const original = (id: number, location: ClaimUnitSource["location"], extra: Partial<ClaimUnitSource> = {}): ClaimUnitSource =>
  ({ id, order_item_id: 7, role: "original", location, ...extra })
const replacement = (id: number, location: ClaimUnitSource["location"]): ClaimUnitSource =>
  ({ id, order_item_id: 7, role: "reemplazo", location, shipment_id: null })
const pickup = (status: ClaimLocalPickupSource["status"], extra: Partial<ClaimLocalPickupSource> = {}): ClaimLocalPickupSource =>
  ({ id: 1, status, agreed_for: null, picked_up_at: null, received_at: null, cancelled_at: null, ...extra })
const view = (input: { resolution?: string; status?: string; units?: ClaimUnitSource[]; pickups?: ClaimLocalPickupSource[]; returnRequired?: boolean; local?: boolean }) =>
  getAdminClaimLogisticsView({
    status: input.status ?? "aprobado",
    resolution: input.resolution ?? "cambio_producto",
    shipments: [],
    units: input.units ?? [],
    localDelivery: input.local ?? true,
    localPickups: input.pickups ?? [],
    returnRequired: input.returnRequired,
  })!

test("Logística: Envío BEYONIX ofrece retiro por cadete o sin devolución (nunca sucursales ni Andreani); Andreani no cambia", () => {
  const change = view({})
  assert.deepEqual(change.methodChoices.map((choice) => [choice.direction, choice.label, choice.available]), [
    ["retiro_cadete", "Retiro por cadete y posterior reemplazo", true],
    ["sin_devolucion_local", "No requiere devolución", true],
  ])
  // Lo que ve el Admin (opciones y próximo paso): sin sucursales, etiquetas ni Andreani.
  assert.doesNotMatch(JSON.stringify([change.methodChoices, change.nextStep]), /sucursal|Andreani|etiqueta/i)
  assert.equal(change.summary.branch, "Sin sucursal", "valor centinela: el panel no muestra sucursal")
  assert.equal(change.plan, null)
  assert.match(change.nextStep, /retiro por cadete/)

  const refund = view({ resolution: "reintegro_total", status: "reintegro_pendiente" })
  assert.deepEqual(refund.methodChoices.map((choice) => choice.label), ["Retiro por cadete y reintegro o saldo", "No requiere devolución"])
  // Mixto: la devolución ya se definió por producto; no se dispensa desde acá.
  assert.deepEqual(view({ resolution: "cambio_producto", returnRequired: true }).methodChoices.map((choice) => choice.direction), ["retiro_cadete"])

  const andreani = view({ local: false })
  assert.deepEqual(andreani.methodChoices.map((choice) => choice.direction), ["devolucion", "cambio", "sin_devolucion"])
  assert.equal(andreani.local, false)
  assert.equal(andreani.localPickup, null)
})

test("retiro pendiente de coordinación: sin fecha obligatoria, sin recepción todavía, no se cierra", () => {
  const pending = view({ units: [original(1, "con_cliente"), original(2, "con_cliente")], pickups: [pickup("pendiente_coordinacion")] })
  assert.equal(pending.plan, "retiro_cadete")
  assert.equal(pending.wizardStep, "logistics")
  assert.equal(pending.summary.status, "Pendiente de coordinación")
  assert.equal(pending.summary.branch, "Sin sucursal")
  assert.match(pending.nextStep, /conversación del reclamo. La fecha es opcional/)
  assert.deepEqual(pending.localPickup && [pending.localPickup.canSchedule, pending.localPickup.canMarkCollected, pending.localPickup.canReceive, pending.localPickup.canCancel],
    [true, true, false, true])
  assert.equal(pending.canClose, false)
  assert.equal(pending.unitActions.some((action) => action.action === "arrival_original"), false, "la llegada se registra con Confirmar recepción")
  assert.equal(pending.methodOptions.length, 0)
  assert.equal(pending.methodLock.status, "blocked")
  assert.match(pending.methodLock.correction ?? "", /cancelá el retiro por cadete/)
})

test("retirado ≠ recibido: se puede recibir, ya no cancelar; recepción parcial sigue abierta en Inspección", () => {
  const collected = view({ units: [original(1, "con_cliente"), original(2, "con_cliente")], pickups: [pickup("retirado", { picked_up_at: "2026-11-06T13:00:00Z" })] })
  assert.equal(collected.summary.status, "Retirado por cadete")
  assert.deepEqual(collected.localPickup && [collected.localPickup.canReceive, collected.localPickup.canCancel, collected.localPickup.canMarkCollected], [true, false, false])
  assert.equal(collected.summary.inspection, "Pendiente")
  assert.match(collected.nextStep, /confirmá la recepción/)

  const partial = view({
    units: [original(1, "recibida_beyonix"), original(2, "con_cliente")],
    pickups: [pickup("recibido_parcial", { picked_up_at: "2026-11-06T13:00:00Z", received_at: "2026-11-06T15:00:00Z" })],
  })
  assert.equal(partial.wizardStep, "reception")
  assert.equal(partial.localPickup?.canReceive, true)
  assert.equal(partial.localPickup?.pendingUnits, 1)
  assert.equal(partial.summary.status, "Pendiente de inspección")
  assert.equal(partial.canClose, false)
})

test("reemplazo local: recibido e inspeccionado -> Entrega (reservar y confirmar entrega, sin Andreani) -> Finalizar", () => {
  const received = { picked_up_at: "2026-11-06T13:00:00Z", received_at: "2026-11-06T15:00:00Z" }
  const inspected = view({ units: [original(1, "reincorporada_stock"), original(2, "baja")], pickups: [pickup("recibido", received)] })
  assert.equal(inspected.wizardStep, "replacement")
  assert.equal(inspected.flow.needsReservation, true)
  assert.match(inspected.nextStep, /Reservá el reemplazo/)
  assert.deepEqual(inspected.flow.checklist.map((item) => [item.key, item.done]), [
    ["requested", true], ["collected", true], ["received", true], ["inspected", true], ["reserved", false], ["delivered", false], ["closed", false],
  ])

  const reserved = view({ units: [original(1, "reincorporada_stock"), original(2, "baja"), replacement(3, "reservada"), replacement(4, "reservada")], pickups: [pickup("recibido", received)] })
  assert.equal(reserved.flow.needsReservation, false)
  const deliver = reserved.unitActions.find((action) => action.action === "deliver_manual")
  assert.equal(deliver?.label, "Confirmar entrega del reemplazo al cliente (cadete o en mano)")
  assert.doesNotMatch(deliver?.label ?? "", /Andreani/)

  const delivered = view({ units: [original(1, "reincorporada_stock"), original(2, "baja"), replacement(3, "entregada_cliente"), replacement(4, "entregada_cliente")], pickups: [pickup("recibido", received)] })
  assert.equal(delivered.wizardStep, "finish")
  assert.equal(delivered.canClose, true)
})

test("reintegro local y 'no requiere devolución': el paso de dinero sigue sus reglas", () => {
  const refund = view({
    resolution: "reintegro_total", status: "reintegro_pendiente",
    units: [original(1, "reincorporada_stock")],
    pickups: [pickup("recibido", { picked_up_at: "2026-11-06T13:00:00Z", received_at: "2026-11-06T15:00:00Z" })],
  })
  assert.equal(refund.wizardStep, "execution")

  const waivedChange = view({ units: [original(1, "conservada_cliente")] })
  assert.equal(waivedChange.plan, "sin_devolucion_local")
  assert.equal(waivedChange.wizardStep, "replacement")
  assert.equal(waivedChange.summary.inspection, "No aplica")
  const waivedRefund = view({ resolution: "saldo_a_favor", units: [original(1, "conservada_cliente")] })
  assert.equal(waivedRefund.wizardStep, "execution")
})

test("wizard: Revisar -> Retiro -> Inspección -> Entrega/Reintegro -> Finalizar", () => {
  const steps = (plan: "retiro_cadete" | "sin_devolucion_local", resolution: string) =>
    getAdminClaimWizard({ status: "aprobado", resolution, receivedUnits: 0, replacedUnits: 0, logistics: { plan, step: "logistics" } }).steps.map((step) => step.label)
  assert.deepEqual(steps("retiro_cadete", "cambio_producto"), ["Revisar", "Retiro", "Inspección", "Entrega", "Finalizar"])
  assert.deepEqual(steps("retiro_cadete", "reintegro_total"), ["Revisar", "Retiro", "Inspección", "Reintegro", "Finalizar"])
  assert.deepEqual(steps("sin_devolucion_local", "cambio_producto"), ["Revisar", "Entrega", "Finalizar"])
})

test("cliente: mensaje simple, fecha sólo si se acordó, nunca Andreani ni detalles internos", () => {
  const base = { status: "aprobado", resolution: "cambio_producto", created_at: "2026-11-05T10:00:00Z", order_claim_shipments: [] }
  const pending = getCustomerClaimSummary({ ...base, order_claim_local_pickups: [pickup("pendiente_coordinacion")] })
  assert.deepEqual([pending.title, pending.lines], ["Coordinaremos el retiro de tu producto", ["Coordinaremos con vos el retiro del producto en tu domicilio."]])
  const failed = getCustomerClaimSummary({ ...base, order_claim_local_pickups: [pickup("incidencia", { incident_note: "Nota interna del cadete" })] })
  assert.equal(failed.title, "Coordinaremos el retiro de tu producto")
  assert.doesNotMatch(JSON.stringify(failed), /Nota interna/)
  const scheduled = getCustomerClaimSummary({ ...base, order_claim_local_pickups: [pickup("coordinado", { agreed_for: "2026-11-08" })] })
  assert.equal(scheduled.title, "Retiro coordinado para el 08/11/2026")
  assert.doesNotMatch(JSON.stringify(scheduled), /\d{1,2}:\d{2}|hs/, "sin horarios")
  const collected = getCustomerClaimSummary({ ...base, order_claim_local_pickups: [pickup("retirado", { picked_up_at: "2026-11-08T13:00:00Z" })] })
  assert.equal(collected.title, "Retiramos tu producto")
  const received = getCustomerClaimSummary({ ...base, order_claim_local_pickups: [pickup("recibido", { picked_up_at: "x", received_at: "y" })] })
  assert.deepEqual([received.title, received.lines], ["Recibimos tu producto", ["Estamos preparando el reemplazo."]])
  for (const summary of [pending, scheduled, collected, received]) {
    assert.doesNotMatch(JSON.stringify(summary), /Andreani|sucursal|etiqueta|QR/i)
    assert.equal(summary.returnLabel, false)
  }
  // Un retiro cancelado no se muestra.
  assert.equal(getCustomerLocalPickupView(pickup("cancelado", { cancelled_at: "z" })), null)
  assert.equal(getCustomerClaimHeadline({ ...base, order_claim_local_pickups: [pickup("coordinado", { agreed_for: "2026-11-08" })] }), "Retiro de tu producto coordinado")
  assert.equal(getCustomerClaimHeadline({ ...base, order_claim_local_pickups: [pickup("recibido", { picked_up_at: "x", received_at: "y" })] }), "Recibimos tu producto: preparando tu reemplazo")
})
