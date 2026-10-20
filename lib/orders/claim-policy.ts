// Fuente única de las reglas comerciales de un reclamo (postventa).
//
// Separa tres conceptos que la interfaz y el backend no deben mezclar:
//   * Problema del cliente (failure_type): qué ocurrió.
//   * Solución comercial (resolution): qué recibe el cliente.
//   * Logística (order_claim_shipments / order_claim_units): qué se mueve.
//
// La matriz de abajo decide qué subsistemas activa cada solución. La UI (admin
// y cliente), las rutas API y los tests la consultan; la base vuelve a exigir
// las mismas reglas (mutate_admin_order_claim, guard_order_claim_logistics,
// guard_claim_credit_note_resolution). Pura: sin imports de app ni de red.

export type ClaimSolution = "replacement" | "refund" | "credit" | "other"

/** Si el producto reclamado vuelve a BEYONIX. */
export type ClaimReturnPolicy =
  /** Lo decide el Admin al elegir la logística (devolver o no). */
  | "optional"
  /** Nunca vuelve (por ejemplo, una unidad que faltó). */
  | "none"

export type ClaimFinancialAction = "none" | "refund" | "customer_credit"

export interface ClaimRequirements {
  solution: ClaimSolution
  /** Nombre comercial (admin y cliente). */
  label: string
  returnPolicy: ClaimReturnPolicy
  /** Lo que vuelve se inspecciona antes de reintegrar, acreditar o reenviar. */
  inspectionWhenReturned: boolean
  /** BEYONIX envía un producto al cliente. */
  outboundShipment: boolean
  financialAction: ClaimFinancialAction
  /**
   * El dinero de un reclamo siempre se mueve con una nota de crédito sobre la
   * factura autorizada (saldo a favor o reintegro externo). Sin acción
   * financiera nunca corresponde NC.
   */
  requiresCreditNote: boolean
  /** El Admin indica el importe al aprobar (saldo por diferencia). */
  requiresAmountOnApproval: boolean
}

export type AcceptedClaimResolution =
  | "cambio_producto"
  | "envio_unidad_faltante"
  | "reintegro_total"
  | "reintegro_parcial"
  | "saldo_a_favor"
  | "cupon_descuento"
  | "otro"

const requirements = (
  solution: ClaimSolution,
  label: string,
  returnPolicy: ClaimReturnPolicy,
  financialAction: ClaimFinancialAction,
  extra: Partial<Pick<ClaimRequirements, "requiresAmountOnApproval">> = {},
): ClaimRequirements => ({
  solution,
  label,
  returnPolicy,
  inspectionWhenReturned: returnPolicy !== "none",
  outboundShipment: solution === "replacement",
  financialAction,
  requiresCreditNote: financialAction !== "none",
  requiresAmountOnApproval: extra.requiresAmountOnApproval ?? false,
})

/** Matriz de resoluciones: única tabla de verdad de la postventa. */
export const CLAIM_RESOLUTION_REQUIREMENTS: Record<AcceptedClaimResolution, ClaimRequirements> = {
  cambio_producto: requirements("replacement", "Reemplazo del producto", "optional", "none"),
  envio_unidad_faltante: requirements("replacement", "Envío de unidad faltante", "none", "none"),
  reintegro_total: requirements("refund", "Reintegro total", "optional", "refund"),
  reintegro_parcial: requirements("refund", "Reintegro parcial", "optional", "refund"),
  saldo_a_favor: requirements("credit", "Saldo a favor", "optional", "customer_credit"),
  cupon_descuento: requirements("credit", "Saldo a favor", "optional", "customer_credit", { requiresAmountOnApproval: true }),
  otro: requirements("other", "Otra solución", "none", "none"),
}

export function isAcceptedClaimResolution(resolution?: string | null): resolution is AcceptedClaimResolution {
  return Boolean(resolution) && Object.prototype.hasOwnProperty.call(CLAIM_RESOLUTION_REQUIREMENTS, resolution as string)
}

/** null: sin decidir o rechazado. */
export function getClaimRequirements(resolution?: string | null): ClaimRequirements | null {
  return isAcceptedClaimResolution(resolution) ? CLAIM_RESOLUTION_REQUIREMENTS[resolution] : null
}

const resolutionsWhere = (predicate: (value: ClaimRequirements) => boolean) =>
  (Object.keys(CLAIM_RESOLUTION_REQUIREMENTS) as AcceptedClaimResolution[])
    .filter((resolution) => predicate(CLAIM_RESOLUTION_REQUIREMENTS[resolution]))

/** Resoluciones con dinero (reintegro o saldo): las únicas que admiten NC. */
export const FINANCIAL_CLAIM_RESOLUTIONS = resolutionsWhere((value) => value.financialAction !== "none")
export const REFUND_CLAIM_RESOLUTIONS = resolutionsWhere((value) => value.financialAction === "refund")
export const CUSTOMER_CREDIT_CLAIM_RESOLUTIONS = resolutionsWhere((value) => value.financialAction === "customer_credit")
export const REPLACEMENT_CLAIM_RESOLUTIONS = resolutionsWhere((value) => value.solution === "replacement")
/** El producto puede volver a BEYONIX (hay que elegir logística). */
export const RETURNABLE_CLAIM_RESOLUTIONS = resolutionsWhere((value) => value.returnPolicy !== "none")

export const isFinancialClaimResolution = (resolution?: string | null) =>
  (FINANCIAL_CLAIM_RESOLUTIONS as readonly string[]).includes(resolution ?? "")
export const isRefundClaimResolution = (resolution?: string | null) =>
  getClaimRequirements(resolution)?.financialAction === "refund"
export const isCustomerCreditClaimResolution = (resolution?: string | null) =>
  getClaimRequirements(resolution)?.financialAction === "customer_credit"
export const isReplacementClaimResolution = (resolution?: string | null) =>
  getClaimRequirements(resolution)?.solution === "replacement"

/**
 * ¿Puede emitirse una nota de crédito ligada a este reclamo? Sólo con una
 * solución económica, o en una solicitud de cancelación (circuito propio). Un
 * reemplazo nunca la muestra ni la emite. La base exige lo mismo
 * (guard_claim_credit_note_resolution).
 */
export function claimAllowsCreditNote(claim: { resolution?: string | null; failure_type?: string | null }) {
  if (claim.failure_type === "cancelar_compra") return true
  return isFinancialClaimResolution(claim.resolution)
}

/** Soluciones que el Admin elige al aprobar, en lenguaje comercial. */
export const CLAIM_SOLUTION_OPTIONS: ReadonlyArray<{ value: AcceptedClaimResolution; label: string }> = [
  { value: "cambio_producto", label: "Reemplazar producto" },
  { value: "envio_unidad_faltante", label: "Enviar unidad faltante" },
  { value: "reintegro_total", label: "Reintegrar dinero" },
  { value: "cupon_descuento", label: "Dar saldo a favor" },
]

/**
 * Si el producto vuelve a BEYONIX, en una palabra para el resumen. `plan` es
 * el plan logístico vigente (claim-shipment-view): la solución dice si puede
 * volver; la logística elegida, si efectivamente vuelve.
 */
export function getClaimReturnSummary(resolution?: string | null, plan?: string | null): string | null {
  const requirements = getClaimRequirements(resolution)
  if (!requirements) return null
  if (requirements.returnPolicy === "none" || plan === "reenvio_sin_devolucion") return "No vuelve"
  if (plan === "retiro" || plan === "retiro_y_reenvio" || plan === "cambio_directo") return "Vuelve a BEYONIX"
  return requirements.solution === "replacement" ? "A definir" : "Sin devolución"
}

// ── Estado financiero del reclamo ───────────────────────────────────────────

export interface ClaimCreditNoteFact {
  claim_id?: number | null
  status?: string | null
  destination?: string | null
  settlement_status?: string | null
  total_amount?: number | string | null
}

export type ClaimFinancialStage = "pending" | "processing" | "done"

export interface ClaimFinancialView {
  action: Exclude<ClaimFinancialAction, "none">
  title: "Reintegro" | "Saldo a favor"
  stage: ClaimFinancialStage
  stageLabel: string
  /** Importe de las NC vigentes del reclamo; null mientras no exista ninguna. */
  amount: number | null
  /** Medio por el que vuelve el dinero. */
  methodLabel: string
}

function paymentLabel(paymentMethodId?: string | null) {
  if (paymentMethodId === "mercadopago") return "Mercado Pago"
  if (paymentMethodId === "transferencia") return "Transferencia"
  if (paymentMethodId === "customer_credit") return "Saldo BEYONIX"
  return "Medio de pago original"
}

/**
 * Bloque financiero simple (Monto / Método / Estado). null cuando la solución
 * no mueve dinero: la interfaz no muestra nada financiero.
 */
export function getClaimFinancialView(input: {
  claimId: number
  resolution?: string | null
  paymentMethodId?: string | null
  creditNotes?: ReadonlyArray<ClaimCreditNoteFact> | null
}): ClaimFinancialView | null {
  const requirements = getClaimRequirements(input.resolution)
  if (!requirements || requirements.financialAction === "none") return null
  const notes = (input.creditNotes ?? []).filter((note) =>
    note.claim_id === input.claimId && (note.status === "processing" || note.status === "authorized"))
  const amount = notes.length
    ? Math.round(notes.reduce((sum, note) => sum + (Number(note.total_amount) || 0), 0) * 100) / 100
    : null
  const settled = notes.length > 0 && notes.every((note) => note.status === "authorized" && note.settlement_status === "completado")
  const stage: ClaimFinancialStage = settled ? "done" : notes.length ? "processing" : "pending"
  const refund = requirements.financialAction === "refund"
  return {
    action: requirements.financialAction,
    title: refund ? "Reintegro" : "Saldo a favor",
    stage,
    stageLabel: stage === "done" ? (refund ? "Realizado" : "Acreditado") : stage === "processing" ? "Procesando" : "Pendiente",
    amount,
    methodLabel: refund ? paymentLabel(input.paymentMethodId) : "Saldo en la cuenta BEYONIX",
  }
}

// ── Cierre ──────────────────────────────────────────────────────────────────

/** Cómo termina el reclamo según su solución (la base exige la misma acción). */
export type ClaimCloseAction =
  /** Reemplazo: confirmar entrega (exige reemplazo registrado y logística resuelta). */
  | "confirm_delivery"
  /** Reintegro: se confirma con el reintegro liquidado (mark_refund_done). */
  | "mark_refund_done"
  /** Saldo: se confirma con la NC acreditada en la cuenta (mark_credit_note_issued). */
  | "mark_credit_issued"
  /** Otra solución: cierre simple. */
  | "close"

export interface ClaimCloseReadiness {
  action: ClaimCloseAction
  canClose: boolean
  /** Qué falta, en texto corto (vacío si se puede cerrar). */
  blockers: string[]
}

export interface ClaimCloseFacts {
  status: string
  resolution?: string | null
  /** Unidades con salida de stock para el reclamo; null = desconocido. */
  replacedUnits: number | null
  /** El reemplazo se verificó contra el servidor. */
  replacementVerified: boolean
  /** Logística del reclamo resuelta (canCloseClaimLogistics); null sin logística de unidades. */
  logisticsResolved: boolean | null
  financial: ClaimFinancialView | null
  /** Pedido marcado como reintegrado (financial_status = refunded). */
  orderRefunded?: boolean
}

/**
 * canCloseClaim central: qué acción cierra el reclamo y si ya puede usarse.
 * Mismas condiciones que mutate_admin_order_claim y guard_order_claim_logistics
 * (la base las vuelve a exigir con el reclamo bloqueado).
 */
export function getClaimCloseReadiness(facts: ClaimCloseFacts): ClaimCloseReadiness | null {
  if (["cerrado", "rechazado"].includes(facts.status)) return null
  const requirements = getClaimRequirements(facts.resolution)
  if (!requirements) return null
  const blockers: string[] = []
  if (facts.logisticsResolved === false) blockers.push("Logística pendiente")

  if (requirements.solution === "replacement") {
    if (!facts.replacementVerified) blockers.push("Verificando el reemplazo")
    else if (facts.resolution === "cambio_producto" && !(facts.replacedUnits !== null && facts.replacedUnits > 0)) {
      blockers.push("Falta registrar el reemplazo")
    } else if (facts.resolution === "envio_unidad_faltante" && facts.replacedUnits !== null && facts.replacedUnits <= 0) {
      blockers.push("Falta registrar la unidad")
    }
    return { action: "confirm_delivery", canClose: blockers.length === 0, blockers }
  }

  if (requirements.financialAction !== "none") {
    const refund = requirements.financialAction === "refund"
    if (facts.financial?.stage !== "done") blockers.push(refund ? "Reintegro pendiente" : "Saldo pendiente de acreditar")
    if (refund && !facts.orderRefunded) blockers.push("Falta registrar el reintegro")
    return { action: refund ? "mark_refund_done" : "mark_credit_issued", canClose: blockers.length === 0, blockers: [...new Set(blockers)] }
  }

  return { action: "close", canClose: blockers.length === 0, blockers }
}

// ── Estado comercial (separado del estado logístico de Andreani) ────────────

export interface ClaimCommercialStatusInput {
  status: string
  resolution?: string | null
  failureType?: string | null
  cancelled?: boolean
  /** Paso logístico vigente (getAdminClaimLogisticsView().wizardStep). */
  logisticsStep?: string | null
  /** El Admin todavía no eligió cómo vuelve (o no) el producto. */
  logisticsPending?: boolean
  financial?: ClaimFinancialView | null
  close?: ClaimCloseReadiness | null
}

/**
 * Estado del reclamo en lenguaje comercial ("Reemplazo en proceso"), nunca el
 * estado crudo de Andreani. El detalle logístico se muestra aparte.
 */
export function getClaimCommercialStatus(input: ClaimCommercialStatusInput): string {
  if (input.status === "cerrado") return input.cancelled ? "Cancelado" : "Resuelto"
  if (input.status === "rechazado") return "Rechazado"
  if (input.status === "falta_informacion") return "Esperando al cliente"
  const requirements = getClaimRequirements(input.resolution)
  if (!requirements || ["recibido", "en_revision"].includes(input.status)) return "En revisión"
  if (input.close?.canClose) return "Listo para finalizar"
  if (input.logisticsPending) return "Definir logística"
  if (input.logisticsStep === "logistics") return requirements.solution === "replacement" ? "Reemplazo en proceso" : "Esperando devolución"
  if (input.logisticsStep === "reception") return "Inspección pendiente"
  if (requirements.solution === "replacement") return "Reemplazo en proceso"
  if (requirements.financialAction === "refund") return input.financial?.stage === "processing" ? "Reintegro en proceso" : "Reintegro pendiente"
  if (requirements.financialAction === "customer_credit") return input.financial?.stage === "processing" ? "Saldo en proceso" : "Saldo pendiente"
  return "Solución en proceso"
}
