import assert from "node:assert/strict"
import test from "node:test"
import {
  getAssistedMercadoPagoRefundDecision,
  getDispatchBlockReasons,
  getMoneyResolutionOptions,
  getResolutionContract,
  type AssistedRefundFacts,
  type DispatchOrderFacts,
} from "./dispatch-eligibility.ts"

const dispatchReady: DispatchOrderFacts = {
  paymentConfirmed: true, invoiceAuthorized: true, cancelled: false, paymentReversed: false,
  financialStatus: "payment_confirmed", openClaim: false, openReturn: false,
  changePending: false, itemsChanged: false, wrongCarrier: false,
  andreaniShipmentReady: true, andreaniCreationUncertain: false,
  handedOverAt: null, trackingInCircuit: false, refundInProgress: false,
}

const refundReady: AssistedRefundFacts = {
  paymentMethod: "mercadopago", paymentApproved: true, amount: 40_000,
  financialStatus: "refund_pending", handedOverAt: null, dispatched: false,
  trackingInCircuit: false, priorRefund: false, fiscalConflict: false,
  claimNeedsInspection: false, physicalReturnPending: false,
  mercadoPagoBalanceConfirmed: true, installments: false,
}

test("prepared and labelled remains under BEYONIX control until physical handover", () => {
  assert.deepEqual(getDispatchBlockReasons(dispatchReady), [])
  assert.deepEqual(getDispatchBlockReasons({ ...dispatchReady, handedOverAt: "2026-10-05T12:00:00Z" }), ["already_handed_over"])
  assert.deepEqual(getDispatchBlockReasons({ ...dispatchReady, openClaim: true }), ["claim"])
  assert.deepEqual(getDispatchBlockReasons({ ...dispatchReady, refundInProgress: true }), ["refund_in_progress"])
})

test("MP refund at the limit is eligible only with admin confirmation", () => {
  assert.deepEqual(getAssistedMercadoPagoRefundDecision(refundReady), {
    kind: "eligible_with_admin_confirmation", amount: 40_000, installments: false,
  })
  assert.deepEqual(getAssistedMercadoPagoRefundDecision({ ...refundReady, installments: true }), {
    kind: "eligible_with_admin_confirmation", amount: 40_000, installments: true,
  })
})

test("handover, high amount, uncertain balance and pending inspection fail closed", () => {
  const result = getAssistedMercadoPagoRefundDecision({
    ...refundReady, amount: 40_000.01, handedOverAt: "2026-10-05T12:00:00Z",
    mercadoPagoBalanceConfirmed: false, physicalReturnPending: true,
  })
  assert.equal(result.kind, "manual_review")
  if (result.kind === "manual_review") assert.deepEqual(result.reasons, ["amount", "dispatch", "inspection", "mp_balance_unverified"])
})

test("only payment-method-appropriate resolutions are offered", () => {
  assert.deepEqual(getMoneyResolutionOptions("mercadopago"), ["customer_balance", "mercadopago"])
  assert.deepEqual(getMoneyResolutionOptions("transferencia"), ["customer_balance", "manual_refund"])
  assert.deepEqual(getMoneyResolutionOptions("customer_credit"), ["customer_balance"])
})

test("NC follows authorized invoice and approved reception; MP partial stays unavailable", () => {
  const base = {
    paid: true, invoiceStatus: "authorized" as const, creditNoteRequired: true,
    creditNoteStatus: "none" as const, creditNoteFinalized: false,
    productMustReturn: true, receptionApproved: false, claimIncidentOpen: false,
    exceptionReason: null, partial: true, paymentMethod: "mercadopago",
  }
  assert.deepEqual(getResolutionContract(base), {
    fiscal: "issue_credit_note", reception: "wait_reception", moneyOptions: [],
  })
  assert.deepEqual(getResolutionContract({ ...base, receptionApproved: true }).moneyOptions, ["customer_balance"])
  assert.deepEqual(getResolutionContract({ ...base, productMustReturn: false, partial: false }).moneyOptions, ["customer_balance", "mercadopago"])
  assert.equal(getResolutionContract({ ...base, creditNoteStatus: "authorized", receptionApproved: true }).fiscal, "finish_credit_note")
  assert.equal(getResolutionContract({ ...base, invoiceStatus: "processing" }).fiscal, "wait_invoice")
})

test("reception exception requires a recorded reason and cannot bypass an open incident", () => {
  const base = {
    paid: true, invoiceStatus: "none" as const, creditNoteRequired: false,
    creditNoteStatus: "none" as const, creditNoteFinalized: false,
    productMustReturn: true, receptionApproved: false, claimIncidentOpen: false,
    exceptionReason: "Cliente conserva la unidad", partial: false, paymentMethod: "transferencia",
  }
  assert.equal(getResolutionContract(base).reception, "exception")
  assert.deepEqual(getResolutionContract(base).moneyOptions, ["customer_balance", "manual_refund"])
  assert.equal(getResolutionContract({ ...base, claimIncidentOpen: true }).reception, "wait_reception")
  assert.deepEqual(getResolutionContract({ ...base, claimIncidentOpen: true }).moneyOptions, [])
})
