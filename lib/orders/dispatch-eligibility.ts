/** Shared, side-effect-free contract for dispatch and assisted refunds.
 * SQL RPCs enforce the same conditions under row locks; this module is for
 * presenting a decision before submitting it, never an authorization layer.
 */
export type DispatchOrderFacts = {
  paymentConfirmed: boolean
  invoiceAuthorized: boolean
  cancelled: boolean
  paymentReversed: boolean
  financialStatus: string | null
  openClaim: boolean
  openReturn: boolean
  changePending: boolean
  itemsChanged: boolean
  wrongCarrier: boolean
  andreaniShipmentReady: boolean
  andreaniCreationUncertain: boolean
  handedOverAt: string | null
  trackingInCircuit: boolean
  refundInProgress: boolean
}

export type DispatchBlockReason =
  | "not_paid" | "invoice_pending" | "cancelled" | "financial_conflict" | "payment_reversed"
  | "claim" | "return" | "change" | "items_changed" | "wrong_carrier" | "shipment_pending"
  | "shipment_uncertain" | "already_handed_over" | "tracking_in_circuit"
  | "refund_in_progress"

export function getDispatchBlockReasons(facts: DispatchOrderFacts): DispatchBlockReason[] {
  const reasons: DispatchBlockReason[] = []
  if (!facts.paymentConfirmed) reasons.push("not_paid")
  if (!facts.invoiceAuthorized) reasons.push("invoice_pending")
  if (facts.cancelled) reasons.push("cancelled")
  if (facts.financialStatus !== "payment_confirmed") reasons.push("financial_conflict")
  if (facts.paymentReversed) reasons.push("payment_reversed")
  if (facts.openClaim) reasons.push("claim")
  if (facts.openReturn) reasons.push("return")
  if (facts.changePending) reasons.push("change")
  if (facts.itemsChanged) reasons.push("items_changed")
  if (facts.wrongCarrier) reasons.push("wrong_carrier")
  if (!facts.andreaniShipmentReady) reasons.push("shipment_pending")
  if (facts.andreaniCreationUncertain) reasons.push("shipment_uncertain")
  if (facts.handedOverAt) reasons.push("already_handed_over")
  if (facts.trackingInCircuit) reasons.push("tracking_in_circuit")
  if (facts.refundInProgress) reasons.push("refund_in_progress")
  return reasons
}

export type AssistedRefundFacts = {
  paymentMethod: string | null
  paymentApproved: boolean
  amount: number
  financialStatus: string | null
  handedOverAt: string | null
  dispatched: boolean
  trackingInCircuit: boolean
  priorRefund: boolean
  fiscalConflict: boolean
  claimNeedsInspection: boolean
  physicalReturnPending: boolean
  mercadoPagoBalanceConfirmed: boolean
  installments: boolean
}

export type AssistedRefundDecision =
  | { kind: "eligible_with_admin_confirmation"; amount: number; installments: boolean }
  | { kind: "manual_review"; reasons: string[] }

/** This never initiates an MP call. Installments always require the same confirmation. */
export function getAssistedMercadoPagoRefundDecision(facts: AssistedRefundFacts): AssistedRefundDecision {
  const reasons: string[] = []
  if (facts.paymentMethod !== "mercadopago" || !facts.paymentApproved) reasons.push("payment")
  if (!Number.isFinite(facts.amount) || facts.amount <= 0 || facts.amount > 40_000) reasons.push("amount")
  if (facts.financialStatus !== "refund_pending") reasons.push("resolution")
  if (facts.handedOverAt || facts.dispatched || facts.trackingInCircuit) reasons.push("dispatch")
  if (facts.priorRefund) reasons.push("prior_refund")
  if (facts.fiscalConflict) reasons.push("fiscal")
  if (facts.claimNeedsInspection || facts.physicalReturnPending) reasons.push("inspection")
  if (!facts.mercadoPagoBalanceConfirmed) reasons.push("mp_balance_unverified")
  return reasons.length
    ? { kind: "manual_review", reasons }
    : { kind: "eligible_with_admin_confirmation", amount: facts.amount, installments: facts.installments }
}

export function getMoneyResolutionOptions(paymentMethod: string | null): Array<"customer_balance" | "mercadopago" | "manual_refund"> {
  if (paymentMethod === "mercadopago") return ["customer_balance", "mercadopago"]
  if (paymentMethod === "transferencia") return ["customer_balance", "manual_refund"]
  if (paymentMethod === "customer_credit") return ["customer_balance"]
  return []
}

export type ResolutionContractFacts = {
  paid: boolean
  invoiceStatus: "none" | "pending" | "processing" | "authorized" | "error"
  creditNoteRequired: boolean
  creditNoteStatus: "none" | "processing" | "authorized" | "error"
  creditNoteFinalized: boolean
  productMustReturn: boolean
  receptionApproved: boolean
  claimIncidentOpen: boolean
  exceptionReason: string | null
  partial: boolean
  paymentMethod: string | null
}

export type FiscalResolutionStep = "none" | "wait_invoice" | "issue_credit_note" | "wait_credit_note" | "finish_credit_note" | "complete"
export type ReceptionResolutionStep = "not_required" | "received" | "wait_reception" | "exception"

/** Maps existing fiscal and reception states to the next work; it never authorizes a fiscal operation. */
export function getResolutionContract(facts: ResolutionContractFacts): {
  fiscal: FiscalResolutionStep
  reception: ReceptionResolutionStep
  moneyOptions: ReturnType<typeof getMoneyResolutionOptions>
} {
  const reception: ReceptionResolutionStep = !facts.productMustReturn
    ? "not_required"
    : facts.receptionApproved
      ? "received"
      : facts.exceptionReason && facts.exceptionReason.trim().length >= 10 && !facts.claimIncidentOpen
        ? "exception"
        : "wait_reception"
  const fiscal: FiscalResolutionStep = !facts.paid || !facts.creditNoteRequired
    ? "none"
    : facts.creditNoteStatus === "authorized"
      ? facts.creditNoteFinalized ? "complete" : "finish_credit_note"
      : facts.creditNoteStatus === "processing"
        ? "wait_credit_note"
        : facts.invoiceStatus === "authorized"
          ? "issue_credit_note"
          : "wait_invoice"
  const moneyOptions = !facts.paid || facts.claimIncidentOpen || reception === "wait_reception"
    ? []
    : getMoneyResolutionOptions(facts.paymentMethod).filter((option) =>
        !(facts.partial && option === "mercadopago"),
      )
  return { fiscal, reception, moneyOptions }
}
