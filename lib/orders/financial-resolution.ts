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
  /** Cancelado con pickeo y todavía sin resolución física (retención activa). */
  physicalHoldActive?: boolean
}

/** Sólo ofrece resultados; la API/RPC vuelve a validar antes de mover dinero. */
export function resolveOrderFinancialOptions(facts: FinancialResolutionFacts): FinancialOption[] {
  if (!facts.paymentApproved || facts.financialStatus !== "refund_pending" ||
      !Number.isFinite(facts.amount) || facts.amount <= 0 ||
      facts.handedOverAt || facts.trackingInCircuit || facts.receptionPending ||
      facts.inspectionPending || facts.claimIncidentOpen || facts.fiscalConflict ||
      facts.priorRefund || facts.refundInProgress || facts.fiscalDestination === "customer_balance") return []

  // Desde el primer pickeo (o con tanda cerrada) nada es automático: sólo
  // acciones explícitas de Admin, y recién con la mercadería recuperada.
  if (facts.preparedAt) {
    if (facts.physicalHoldActive) return []
    const options: FinancialOption[] = []
    if (["transferencia", "mercadopago"].includes(facts.paymentMethod ?? "")) {
      options.push({ type: "manual_refund", label: "Reintegro manual", requiresConfirmation: true })
    }
    // Reintegro por Mercado Pago iniciado por Admin desde BEYONIX: el mismo
    // clic emite antes la NC C y devuelve sólo lo capturado por MP (en un pago
    // combinado el saldo vuelve con la NC, nunca por este refund).
    if (facts.paymentMethod === "mercadopago" && facts.paymentIdValid &&
        Number.isFinite(facts.mpAmount) && facts.mpAmount > 0 && facts.mpAmount === facts.amount &&
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
      options.push({ type: "mercadopago_refund", label: "Reintegrar por Mercado Pago", requiresConfirmation: true })
    }
    return options
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
    options.push({ type: "mercadopago_refund", label: "Reintegrar por Mercado Pago", requiresConfirmation: true })
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

/** Una reserva sin lease más vieja que esto quedó cortada entre reservar y ejecutar. */
export const FINANCIAL_STALE_RESERVATION_MS = 5 * 60_000

/**
 * Estado real de la resolución para mostrar y decidir la acción: un intento
 * "en proceso" cuyo lease venció (request cortado, timeout) no avanza solo y
 * claim_order_financial_resolution ya acepta retomarlo, así que requiere que
 * el Admin reintente. Nunca cambia la fila: sólo cómo se lee.
 */
export function getEffectiveFinancialResolutionStatus(
  resolution: { status: string; lease_until?: string | null; updated_at?: string | null },
  now = Date.now(),
): string {
  if (resolution.status === "processing") {
    const leaseUntil = resolution.lease_until ? Date.parse(resolution.lease_until) : Number.NaN
    return Number.isFinite(leaseUntil) && leaseUntil > now ? "processing" : "requires_action"
  }
  if (resolution.status === "reserved") {
    const updatedAt = resolution.updated_at ? Date.parse(resolution.updated_at) : Number.NaN
    return Number.isFinite(updatedAt) && now - updatedAt < FINANCIAL_STALE_RESERVATION_MS ? "reserved" : "requires_action"
  }
  return resolution.status
}

export const FINANCIAL_INTERRUPTED_DETAIL = "La operación anterior se interrumpió antes de terminar. Reintentá la actualización."

export function financialHumanStatus(status: string | null): FinancialHumanStatus {
  if (status === "completed") return "Completado"
  if (status === "processing" || status === "reserved") return "En proceso"
  if (status === "requires_action" || status === "manual_pending") return "Requiere acción"
  if (status === "error") return "Error"
  return "Pendiente"
}
