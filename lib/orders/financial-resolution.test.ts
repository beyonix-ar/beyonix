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
test("MP ofrece reintegro por encima de $40.000 sólo con monto verificado y confirmación", () => {
  for (const amount of [39_999, 40_000, 40_001, 100_000, 100_001]) {
    assert.equal(resolveOrderFinancialOptions({ ...base, amount, mpAmount: amount }).find((option) => option.type === "mercadopago_refund")?.requiresConfirmation, true)
  }
  assert.equal(choices({ remotePaymentVerified: false }).includes("mercadopago_refund"), false)
  assert.equal(choices({ amount: 100_001, mpAmount: 100_000 }).includes("mercadopago_refund"), false)
  assert.equal(choices({ preparedAt: "2026-10-05T12:00:00Z", amount: 100_001, mpAmount: 100_000 }).includes("mercadopago_refund"), false)
  assert.equal(choices({ preparedAt: "2026-10-05T12:00:00Z", physicalHoldActive: true, amount: 100_000, mpAmount: 100_000 }).includes("mercadopago_refund"), false)
})
test("pickeo/tanda preparada: sólo acciones de Admin (manual o Reintegrar por MP); con retención activa, nada", () => {
  // "Manual" = el Admin autoriza desde BEYONIX: transferencia registrada o refund de MP con un clic.
  assert.deepEqual(choices({ preparedAt: "2026-10-05T12:00:00Z" }), ["manual_refund", "mercadopago_refund"])
  assert.deepEqual(choices({ preparedAt: "2026-10-05T12:00:00Z", physicalHoldActive: true }), [], "primero la resolución física")
  // Pago combinado: MP devuelve sólo lo capturado (la NC fija el monto externo).
  assert.deepEqual(choices({ preparedAt: "2026-10-05T12:00:00Z", partial: true, amount: 30_000, mpAmount: 30_000 }), ["manual_refund", "mercadopago_refund"])
  assert.deepEqual(choices({ preparedAt: "2026-10-05T12:00:00Z", amount: 20_000, mpAmount: 30_000 }), ["manual_refund"], "monto distinto de lo capturado: sólo manual")
  assert.deepEqual(choices({ preparedAt: "2026-10-05T12:00:00Z", remotePaymentVerified: false }), ["manual_refund"], "sin verificar el pago en MP, no se ofrece")
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
