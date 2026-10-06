import test from "node:test"
import assert from "node:assert/strict"
import { resolveOrderFinancialOptions, financialHumanStatus, type FinancialResolutionFacts } from "./financial-resolution.ts"

const base: FinancialResolutionFacts = {
  paymentMethod: "mercadopago", paymentApproved: true, paymentIdValid: true,
  amount: 39_999, mpAmount: 39_999, financialStatus: "refund_pending",
  preparedAt: null, handedOverAt: null, trackingInCircuit: false,
  shipmentCreated: false,
  priorRefund: false, refundInProgress: false, fiscalConflict: false,
  receptionPending: false, inspectionPending: false, claimIncidentOpen: false,
  remotePaymentVerified: true, partial: false, installments: false,
  hasCustomerAccount: true,
  fiscalDestination: null,
}
const choices = (facts: Partial<FinancialResolutionFacts> = {}) =>
  resolveOrderFinancialOptions({ ...base, ...facts }).map((option) => option.type)

test("MP aprobado bajo $40.000 ofrece MP y saldo, siempre con confirmación", () => {
  assert.deepEqual(choices(), ["beyonix_credit", "mercadopago_refund"])
  assert.equal(resolveOrderFinancialOptions({ ...base, installments: true }).every((option) => option.requiresConfirmation), true)
})
test("MP supera el límite o no pasa la verificación remota", () => {
  assert.equal(choices({ amount: 40_001, mpAmount: 40_001 }).includes("mercadopago_refund"), false)
  assert.equal(choices({ remotePaymentVerified: false }).includes("mercadopago_refund"), false)
})
test("tanda preparada y entrega física cortan toda automatización", () => {
  assert.deepEqual(choices({ preparedAt: "2026-10-05T12:00:00Z" }), ["manual_refund"])
  assert.deepEqual(choices({ handedOverAt: "2026-10-05T12:00:00Z" }), [])
  assert.deepEqual(choices({ trackingInCircuit: true }), [])
  assert.deepEqual(choices({ shipmentCreated: true }), ["beyonix_credit"])
})
test("refund previo, en curso, conflicto fiscal o recepción bloquean la resolución", () => {
  for (const facts of [{ priorRefund: true }, { refundInProgress: true }, { fiscalConflict: true },
    { receptionPending: true }, { inspectionPending: true }, { claimIncidentOpen: true }]) {
    assert.deepEqual(choices(facts), [])
  }
})
test("refund parcial no expone el camino MP", () => {
  assert.deepEqual(choices({ amount: 10_000, mpAmount: 39_999, partial: true }), ["beyonix_credit"])
  assert.deepEqual(choices({ amount: 10_000, mpAmount: 39_999, partial: true, fiscalDestination: "external_refund" }), ["manual_refund"])
})
test("transferencia ofrece reintegro manual y saldo; preparada sólo manual", () => {
  assert.deepEqual(choices({ paymentMethod: "transferencia" }), ["beyonix_credit", "manual_refund"])
  assert.deepEqual(choices({ paymentMethod: "transferencia", preparedAt: "2026-10-05T12:00:00Z" }), ["manual_refund"])
})
test("estados humanos presentan un único reintento", () => {
  assert.equal(financialHumanStatus("requires_action"), "Requiere acción")
  assert.equal(financialHumanStatus("completed"), "Completado")
  assert.equal(financialHumanStatus("processing"), "En proceso")
})
