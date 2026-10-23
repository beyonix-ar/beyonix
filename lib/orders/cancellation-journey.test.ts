import assert from "node:assert/strict"
import test from "node:test"

import { getCancellationJourney, type CancellationJourneyOrder } from "./cancellation-journey.ts"
import { isOrderDispatchCutoffReached } from "./dispatch-cutoff.ts"
import { buildCustomerCancellationNotification } from "../admin/admin-notification-rules.ts"
import { dispatchError, dispatchIssueLabel, holdBundleLabel, parseDispatchHandoverIssues, DISPATCH_HANDOVER_BLOCKED_MESSAGE } from "../admin/dispatch.ts"
import { cancellationResolveHref, parseCancellationReturn } from "../admin/dispatch-location.ts"

const dispatch = (overrides: Record<string, unknown> = {}) => ({
  batchId: null, batchNumber: null, batchStatus: null, packageStatus: "prepared", blocked: true,
  physicalHold: false, manualRefundRequired: false, ...overrides,
}) as NonNullable<CancellationJourneyOrder["admin_pending_facts"]>["dispatch"]
const cancelled = (overrides: Partial<CancellationJourneyOrder> = {}): CancellationJourneyOrder => ({
  id: 32, estado: "cancelado", financial_status: "refund_pending", payment_method_id: "mercadopago",
  payment_status: "approved", paid_at: "2026-10-22T10:00:00Z", payment_confirmed_amount: 899, total: 899,
  invoice_status: "authorized", invoice_cae: "CAE-1", credit_note_required: true, order_credit_notes: [],
  mercadopago_order_refunds: [], cancelled_at: "2026-10-22T11:00:00Z", ...overrides,
})
const statuses = (order: CancellationJourneyOrder) =>
  Object.fromEntries(getCancellationJourney(order)!.steps.map((step) => [step.key, step.status]))

test("A: sin pickeo el stock volvió solo y el siguiente paso es el dinero", () => {
  const journey = getCancellationJourney(cancelled({ admin_pending_facts: { financial: { mode: "wizard", resolutionStatus: null, hasOptions: true }, dispatch: dispatch({ packageStatus: null }) } }))!
  assert.deepEqual(journey.steps.map((step) => step.label), ["Cancelación", "Mercadería", "Dinero", "Nota de crédito", "Reintegro", "Finalizado"])
  assert.equal(journey.current, "money")
  assert.equal(journey.action, null)
  assert.match(journey.steps[1].detail, /el stock volvió automáticamente/)
})

test("B/C: con mercadería en un Bulto, primero 'Resolver mercadería' (vuelve al mismo paso) y el dinero espera", () => {
  const order = cancelled({ admin_pending_facts: { financial: { mode: "none", resolutionStatus: null, hasOptions: false }, dispatch: dispatch({ physicalHold: true, manualRefundRequired: true, batchId: 41, batchNumber: 8, batchStatus: "closed" }) } })
  const journey = getCancellationJourney(order)!
  assert.equal(journey.current, "merchandise")
  assert.match(journey.steps[1].detail, /Bulto 0008: retiralo antes de entregarlo/)
  assert.deepEqual(journey.action, { kind: "resolve_merchandise", label: "Resolver mercadería", href: "/admin/despachos?resolve=32&return=%2Fadmin%2Fpedidos%2F32%3Ftab%3Dcancelacion" })
  assert.equal(journey.action?.href, cancellationResolveHref(32), "mismo enlace que Despachos")
  assert.equal(statuses(order).money, "waiting")
  // Resuelta la mercadería: el mismo pedido muestra el paso siguiente (refresh/back no pierden nada).
  const resolved = cancelled({ admin_pending_facts: { financial: { mode: "wizard", resolutionStatus: null, hasOptions: true }, dispatch: dispatch({ manualRefundRequired: true }) } })
  assert.deepEqual([statuses(resolved).merchandise, getCancellationJourney(resolved)!.current], ["done", "money"])
})

test("reintegro manual pendiente, en proceso y finalizado", () => {
  const manual = cancelled({ admin_pending_facts: { financial: { mode: "resolution", resolutionStatus: "manual_pending", hasOptions: false }, dispatch: null },
    order_credit_notes: [{ status: "authorized", destination: "external_refund", settlement_status: "pendiente", total_amount: 899 }] })
  assert.deepEqual([statuses(manual).money, statuses(manual).credit_note, statuses(manual).refund], ["done", "done", "current"])
  const finished = cancelled({ financial_status: "refunded", order_credit_notes: [{ status: "authorized", destination: "external_refund", settlement_status: "completado", total_amount: 899 }] })
  const journey = getCancellationJourney(finished)!
  assert.equal(journey.finished, true)
  assert.equal(journey.current, null)
  assert.equal(statuses(finished).finished, "done")
})

test("sin pago: no hay dinero ni NC; con comprobante en revisión, primero el pago", () => {
  const unpaid = cancelled({ financial_status: "cancelled", paid_at: null, payment_confirmed_amount: 0, payment_status: "rejected", credit_note_required: false, invoice_status: null, invoice_cae: null })
  assert.deepEqual([statuses(unpaid).money, statuses(unpaid).credit_note, statuses(unpaid).refund], ["not_required", "not_required", "not_required"])
  assert.equal(getCancellationJourney(unpaid)!.finished, true)
  const review = cancelled({ financial_status: "cancellation_requested", paid_at: null, payment_confirmed_amount: 0, payment_status: "en_revision", payment_proof_url: "proof.pdf", credit_note_required: false })
  assert.equal(getCancellationJourney(review)!.current, "money")
  assert.equal(statuses(review).money, "attention")
})

test("pedido no cancelado: sin asistente", () => {
  assert.equal(getCancellationJourney({ id: 1, estado: "pagado", financial_status: "payment_confirmed" }), null)
})

test("corte canónico en TS: igual que la base", () => {
  assert.equal(isOrderDispatchCutoffReached({ andreani_envio_id: "ENV", andreani_tracking: "360" }, true), false, "en Bulto sin QR final")
  assert.equal(isOrderDispatchCutoffReached({ andreani_envio_id: "ENV" }, false), true, "envío histórico sin armado")
  assert.equal(isOrderDispatchCutoffReached({ andreani_handed_over_at: "2026-10-22T12:00:00Z" }, true), true, "QR final")
  assert.equal(isOrderDispatchCutoffReached({ estado: "entregado" }, true), true)
  assert.equal(isOrderDispatchCutoffReached({ andreani_estado: "En tránsito" }, true), true)
  assert.equal(isOrderDispatchCutoffReached({ estado: "pagado" }), false)
})

test("R: aviso al Admin 'cancelado por el cliente', sin duplicar la tarea física del Bulto", () => {
  const order = { id: 32, estado: "cancelado", usuario_id: "u-1", cancellation_requested_by: "u-1", cancellation_requested_at: "2026-10-22T11:00:00Z" }
  const notice = buildCustomerCancellationNotification(order)!
  assert.deepEqual([notice.title, notice.body, notice.kind, notice.actionUrl], ["Pedido cancelado", "#BX-1032 fue cancelado por el cliente.", "info", "/admin/pedidos/32?tab=cancelacion"])
  assert.equal(buildCustomerCancellationNotification({ ...order, cancellation_requested_by: "admin-1" }), null, "lo canceló Admin")
  assert.equal(buildCustomerCancellationNotification({ ...order, admin_pending_facts: { financial: null, dispatch: dispatch({ physicalHold: true }) } }), null,
    "con mercadería pickeada avisa Despachos: 'Pedido cancelado en Bulto 0008'")
})

test("QR rechazado: la lista completa de pedidos y un motivo humano por pedido", () => {
  const detail = JSON.stringify([{ orderId: 32, reasons: ["cancelled", "claim", "financial_conflict", "physical_hold"] }, { orderId: 38, reasons: ["claim"] }, { orderId: 41, reasons: ["not_prepared"] }])
  const issues = parseDispatchHandoverIssues({ message: "DISPATCH_ORDER_BLOCKED", details: detail })!
  assert.deepEqual(issues.map((issue) => [issue.orderId, dispatchIssueLabel(issue.reasons)]), [[32, "Cancelado"], [38, "Reclamo abierto"], [41, "Armado incompleto"]])
  assert.equal(dispatchError({ message: "DISPATCH_ORDER_BLOCKED", details: detail }), DISPATCH_HANDOVER_BLOCKED_MESSAGE)
  assert.equal(parseDispatchHandoverIssues({ message: "DISPATCH_ORDER_BLOCKED", details: "32" }), null, "el error histórico de un solo pedido sigue igual")
  assert.equal(dispatchError({ message: "DISPATCH_ORDER_BLOCKED", details: "32" }), "BX-1032: Este pedido requiere revisión antes del despacho.")
  assert.equal(holdBundleLabel("Bulto - 0008"), "Bulto - 0008")
  assert.equal(holdBundleLabel("DSP-20261016-001"), "Bulto general DSP-20261016-001")
})

test("Q: la vuelta desde Despachos sólo acepta el paso de cancelación del pedido", () => {
  assert.equal(parseCancellationReturn("/admin/pedidos/32?tab=cancelacion"), "/admin/pedidos/32?tab=cancelacion")
  for (const value of ["https://evil.test/admin/pedidos/32?tab=cancelacion", "/admin/pedidos/32", "//evil.test", "/admin/pedidos/32?tab=cancelacion&x=1", null]) {
    assert.equal(parseCancellationReturn(value), null, String(value))
  }
})
