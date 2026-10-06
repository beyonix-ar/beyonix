import { getAssistedMercadoPagoRefundDecision } from "./dispatch-eligibility.ts"

export type FinancialChoice = "beyonix_credit" | "mercadopago_refund" | "manual_refund"
export type FinancialHumanStatus = "Pendiente" | "En proceso" | "Requiere acción" | "Completado" | "Error"
export type FinancialOption = { type: FinancialChoice; label: string; requiresConfirmation: true }

export type FinancialResolutionFacts = {
  paymentMethod: string | null
  paymentApproved: boolean
  paymentIdValid: boolean
  amount: number
  mpAmount: number
  financialStatus: string | null
  preparedAt: string | null
  handedOverAt: string | null
  trackingInCircuit: boolean
  shipmentCreated: boolean
  priorRefund: boolean
  refundInProgress: boolean
  fiscalConflict: boolean
  receptionPending: boolean
  inspectionPending: boolean
  claimIncidentOpen: boolean
  remotePaymentVerified: boolean
  partial: boolean
  installments: boolean
  hasCustomerAccount: boolean
  fiscalDestination: "external_refund" | "customer_balance" | null
}

/** Sólo ofrece resultados; la API/RPC vuelve a validar antes de mover dinero. */
export function resolveOrderFinancialOptions(facts: FinancialResolutionFacts): FinancialOption[] {
  if (!facts.paymentApproved || facts.financialStatus !== "refund_pending" ||
      !Number.isFinite(facts.amount) || facts.amount <= 0 ||
      facts.handedOverAt || facts.trackingInCircuit || facts.receptionPending ||
      facts.inspectionPending || facts.claimIncidentOpen || facts.fiscalConflict ||
      facts.priorRefund || facts.refundInProgress || facts.fiscalDestination === "customer_balance") return []

  // Una tanda cerrada ya dejó la mercadería embalada: sólo gestión manual.
  if (facts.preparedAt) {
    return ["transferencia", "mercadopago"].includes(facts.paymentMethod ?? "")
      ? [{ type: "manual_refund", label: "Reintegro manual", requiresConfirmation: true }]
      : []
  }

  const options: FinancialOption[] = []
  if (facts.hasCustomerAccount && !facts.fiscalDestination) options.push({ type: "beyonix_credit", label: "Saldo BEYONIX", requiresConfirmation: true })
  if (facts.paymentMethod === "transferencia" || (facts.paymentMethod === "mercadopago" && facts.partial && facts.fiscalDestination === "external_refund")) {
    options.push({ type: "manual_refund", label: "Reintegro manual", requiresConfirmation: true })
  }
  if (facts.paymentMethod === "mercadopago" && facts.paymentIdValid &&
      Number.isFinite(facts.mpAmount) && facts.mpAmount === facts.amount && !facts.partial &&
      getAssistedMercadoPagoRefundDecision({
        paymentMethod: facts.paymentMethod, paymentApproved: facts.paymentApproved,
        amount: facts.mpAmount, financialStatus: facts.financialStatus,
        handedOverAt: facts.handedOverAt, dispatched: facts.shipmentCreated,
        trackingInCircuit: facts.trackingInCircuit, priorRefund: facts.priorRefund,
        fiscalConflict: facts.fiscalConflict, claimNeedsInspection: facts.inspectionPending,
        physicalReturnPending: facts.receptionPending,
        mercadoPagoBalanceConfirmed: facts.remotePaymentVerified,
        installments: facts.installments,
      }).kind === "eligible_with_admin_confirmation") {
    options.push({ type: "mercadopago_refund", label: "Reembolsar al medio de pago original", requiresConfirmation: true })
  }
  return options
}

export type FinancialProductOutcome = "no_return" | "return"
/** unavailable: el producto debe volver pero no hay devolución registrada. */
export type FinancialReceptionState = "not_applicable" | "received" | "pending" | "exception" | "unavailable"
export type FinancialClaimUnit = { claimId: number; role: string; location: string }
export type FinancialResolutionMode = "wizard" | "resolution" | "advanced" | "none"

const RECEIVED_UNIT_LOCATIONS = ["reincorporada_stock", "baja"]

/**
 * Qué pasa con el producto según lo que BEYONIX ya registró. Usa el mismo
 * reclamo activo que `assert_order_claim_money_released`: el último abierto
 * con unidades; una excepción registrada para ese reclamo libera el dinero.
 */
export function deriveFinancialReturnContext(input: {
  handedOverAt: string | null
  units: FinancialClaimUnit[]
  claimBlock: string | null
  exceptionClaimIds: number[]
}): { product: FinancialProductOutcome; reception: FinancialReceptionState; claimId: number | null } {
  const claimId = input.units.reduce<number | null>((max, unit) => max === null || unit.claimId > max ? unit.claimId : max, null)
  const returning = input.units.filter((unit) => unit.claimId === claimId && unit.role === "original" && unit.location !== "conservada_cliente")
  if (returning.length === 0) {
    const leftWithoutReturn = !!input.handedOverAt && !input.units.some((unit) => unit.role === "original")
    return leftWithoutReturn
      ? { product: "return", reception: "unavailable", claimId: null }
      : { product: "no_return", reception: "not_applicable", claimId }
  }
  if (input.claimBlock === "CLAIM_MONEY_RETURN_PENDING") {
    return { product: "return", reception: claimId !== null && input.exceptionClaimIds.includes(claimId) ? "exception" : "pending", claimId }
  }
  return { product: "return", reception: returning.every((unit) => RECEIVED_UNIT_LOCATIONS.includes(unit.location)) ? "received" : "pending", claimId }
}

export function getFinancialResolutionMode(input: {
  financialStatus: string | null
  hasResolution: boolean
  options: FinancialOption[]
  receptionOptions: FinancialOption[]
}): FinancialResolutionMode {
  if (input.hasResolution) return "resolution"
  if (input.options.length > 0 || input.receptionOptions.length > 0) return "wizard"
  return input.financialStatus === "refund_pending" ? "advanced" : "none"
}

export function financialHumanStatus(status: string | null): FinancialHumanStatus {
  if (status === "completed") return "Completado"
  if (status === "processing" || status === "reserved") return "En proceso"
  if (status === "requires_action" || status === "manual_pending") return "Requiere acción"
  if (status === "error") return "Error"
  return "Pendiente"
}
