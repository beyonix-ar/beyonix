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
  /**
   * Cancelado con pickeo y la mercadería ya volvió (retención resuelta por
   * escaneo, fuera de todo Bulto): el Admin puede elegir también saldo BEYONIX.
   */
  pickedCancellationResolved?: boolean
  /** Cancelación ya despachada (corte canónico): el dinero espera la inspección de la devolución. */
  returnInspectionRequired?: boolean
  /** Devolución recibida, inspeccionada y con el dinero aprobado (order_return_inspections). */
  returnApproved?: boolean
}

/** Sólo ofrece resultados; la API/RPC vuelve a validar antes de mover dinero. */
export function resolveOrderFinancialOptions(facts: FinancialResolutionFacts): FinancialOption[] {
  const dispatched = Boolean(facts.handedOverAt || facts.trackingInCircuit || facts.returnInspectionRequired)
  if (!facts.paymentApproved || facts.financialStatus !== "refund_pending" ||
      !Number.isFinite(facts.amount) || facts.amount <= 0 ||
      (dispatched && !facts.returnApproved) || facts.receptionPending ||
      facts.inspectionPending || facts.claimIncidentOpen || facts.fiscalConflict ||
      facts.priorRefund || facts.refundInProgress || facts.fiscalDestination === "customer_balance") return []

  // Devolución aprobada (misma regla que reserve_order_financial_resolution):
  // saldo o reintegro externo, nunca un refund automático de Mercado Pago.
  if (dispatched) {
    const options: FinancialOption[] = []
    if (facts.hasCustomerAccount && !facts.fiscalDestination) options.push({ type: "beyonix_credit", label: "Saldo BEYONIX", requiresConfirmation: true })
    if (["transferencia", "mercadopago"].includes(facts.paymentMethod ?? "")) {
      options.push({ type: "manual_refund", label: "Reintegro manual", requiresConfirmation: true })
    }
    return options
  }

  // Desde el primer pickeo (o con tanda cerrada) nada es automático: sólo
  // acciones explícitas de Admin, y recién con la mercadería recuperada.
  if (facts.preparedAt) {
    if (facts.physicalHoldActive) return []
    const options: FinancialOption[] = []
    // Misma condición que reserve_order_financial_resolution (20261023100000).
    if (facts.pickedCancellationResolved && facts.hasCustomerAccount && !facts.fiscalDestination) {
      options.push({ type: "beyonix_credit", label: "Saldo BEYONIX", requiresConfirmation: true })
    }
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
  /** Cancelación despachada sin inspección: el Admin la registra en el mismo asistente. */
  returnInspectionPending?: boolean
  /** Devolución del dinero rechazada: resultado final, sin opciones. */
  moneyRejected?: boolean
}): FinancialResolutionMode {
  if (input.hasResolution || input.moneyRejected) return "resolution"
  if (input.options.length > 0 || input.receptionOptions.length > 0 || input.returnInspectionPending) return "wizard"
  return input.financialStatus === "refund_pending" ? "advanced" : "none"
}

export type ReturnPhysicalState = "received_ok" | "not_received" | "damaged" | "incomplete" | "wrong_product"
export type ReturnMoneyDecision = "approved" | "rejected"
export type MerchandiseSituation = "not_dispatched" | "not_returned" | ReturnPhysicalState

export const RETURN_PHYSICAL_STATES: readonly ReturnPhysicalState[] = ["received_ok", "not_received", "damaged", "incomplete", "wrong_product"]
export const RETURN_REJECTION_REASON_MIN_LENGTH = 10

/** Texto único de la situación de la mercadería (Admin: asistente, modal y resumen). */
export const MERCHANDISE_SITUATION_COPY: Record<MerchandiseSituation, string> = {
  not_dispatched: "El producto no se despachó.",
  not_returned: "El producto aún no volvió.",
  received_ok: "El producto volvió correctamente.",
  not_received: "Producto no recibido.",
  damaged: "Producto recibido dañado.",
  incomplete: "Producto recibido con faltantes.",
  wrong_product: "Producto recibido incorrecto.",
}

export const RETURN_PHYSICAL_STATE_LABELS: Record<ReturnPhysicalState, string> = {
  received_ok: "Producto recibido correctamente",
  not_received: "Producto no recibido",
  damaged: "Producto recibido dañado",
  incomplete: "Producto recibido con faltantes",
  wrong_product: "Producto incorrecto",
}

export type ReturnInspectionInput = {
  physicalState: ReturnPhysicalState
  decision: ReturnMoneyDecision
  reason: string
  customerMessage: string
}

/** Misma validación que record_order_return_inspection (la base la repite). */
export function getReturnInspectionInputError(input: Partial<Record<keyof ReturnInspectionInput, unknown>>): string | null {
  if (!RETURN_PHYSICAL_STATES.includes(input.physicalState as ReturnPhysicalState)) return "Indicá en qué estado se recibió la mercadería."
  if (input.decision !== "approved" && input.decision !== "rejected") return "Elegí si aprobás o rechazás la devolución del dinero."
  if (input.decision === "approved" && input.physicalState === "not_received") return "Sin la mercadería recibida no se puede aprobar la devolución del dinero."
  const reason = typeof input.reason === "string" ? input.reason.trim() : ""
  if (input.decision === "rejected" && (reason.length < RETURN_REJECTION_REASON_MIN_LENGTH || reason.length > 600)) {
    return `Indicá el motivo del rechazo (mínimo ${RETURN_REJECTION_REASON_MIN_LENGTH} caracteres).`
  }
  const message = typeof input.customerMessage === "string" ? input.customerMessage.trim() : ""
  if (message.length > 300) return "El mensaje para el cliente admite hasta 300 caracteres."
  return null
}

/**
 * Situación real de la mercadería: lo inspeccionado manda; sin inspección, si
 * el pedido salió de BEYONIX (o hay una devolución por reclamo) y si ya volvió.
 */
export function deriveMerchandiseSituation(input: {
  dispatched: boolean
  inspection: ReturnPhysicalState | null
  product: FinancialProductOutcome
  reception: FinancialReceptionState
}): MerchandiseSituation {
  if (input.inspection) return input.inspection
  if (input.product === "return") return input.reception === "received" ? "received_ok" : "not_returned"
  return input.dispatched ? "not_returned" : "not_dispatched"
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
