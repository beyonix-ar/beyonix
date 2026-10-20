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
 * reemplazo nunca la muestra ni la emite. En un reclamo mixto sí, pero sólo
 * por las unidades de reintegro o saldo (getClaimCreditableQuantities). La base
 * exige lo mismo (guard_claim_credit_note_resolution,
 * guard_mixed_claim_credit_note_item).
 */
export function claimAllowsCreditNote(claim: { resolution?: string | null; failure_type?: string | null }) {
  if (claim.failure_type === "cancelar_compra") return true
  return isFinancialClaimResolution(claim.resolution) || isMixedClaimResolution(claim.resolution)
}

/** Explicación breve de "Cambiar por otro producto" (sin conceptos fiscales). */
export const CLAIM_PRODUCT_CHANGE_HINT = "Se acredita el valor correspondiente como saldo a favor para realizar una nueva compra."

/**
 * Soluciones que el Admin elige al aprobar, en lenguaje comercial. "Cambiar
 * por otro producto" NO es un intercambio dentro del reclamo: se resuelve como
 * saldo a favor por el valor de los productos y la compra nueva es un pedido
 * normal (checkout, precios, stock y facturación propios).
 */
export const CLAIM_SOLUTION_OPTIONS: ReadonlyArray<{ value: AcceptedClaimResolution; label: string; hint?: string }> = [
  { value: "cambio_producto", label: "Reemplazar producto" },
  { value: "envio_unidad_faltante", label: "Enviar unidad faltante" },
  { value: "reintegro_total", label: "Reintegrar dinero" },
  { value: "saldo_a_favor", label: "Cambiar por otro producto", hint: CLAIM_PRODUCT_CHANGE_HINT },
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
  /** Renglones de la NC (reclamo mixto: qué unidades cubre). */
  order_credit_note_items?: ReadonlyArray<{ order_item_id: number; quantity: number }> | null
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
  /** Reclamo mixto: progreso por producto (getMixedClaimView). */
  mixed?: MixedClaimView | null
}

/**
 * canCloseClaim central: qué acción cierra el reclamo y si ya puede usarse.
 * Mismas condiciones que mutate_admin_order_claim, order_claim_mixed_blockers
 * y guard_order_claim_logistics (la base las vuelve a exigir con el reclamo
 * bloqueado). Un reclamo mixto cierra sólo con TODAS las unidades resueltas.
 */
export function getClaimCloseReadiness(facts: ClaimCloseFacts): ClaimCloseReadiness | null {
  if (["cerrado", "rechazado"].includes(facts.status)) return null
  if (isMixedClaimResolution(facts.resolution)) {
    if (!facts.mixed) return null
    const blockers = [...(facts.logisticsResolved === false ? ["Logística pendiente"] : []), ...facts.mixed.blockers]
    return { action: "close", canClose: blockers.length === 0, blockers: [...new Set(blockers)] }
  }
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
  if (isMixedClaimResolution(input.resolution) && !["recibido", "en_revision"].includes(input.status)) {
    if (input.close?.canClose) return "Listo para finalizar"
    if (input.logisticsPending) return "Definir logística"
    if (input.logisticsStep === "logistics") return "Esperando devolución"
    if (input.logisticsStep === "reception") return "Inspección pendiente"
    return "Solución por producto en proceso"
  }
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

// ── Resolución por producto (reclamo mixto) ─────────────────────────────────
//
// Reclamo
//   └ ítems reclamados (affected_items)
//        └ resolución por unidad: replacement | refund | credit
//
// Un reclamo simple conserva su resolución global y se interpreta como esa
// solución para TODAS sus unidades (compatibilidad: los históricos no se
// migran). Un reclamo mixto (resolution = "mixta") guarda el reparto en
// order_claim_item_resolutions. Cada solución reutiliza su sistema existente
// (reemplazo/stock, NC + reintegro, NC + saldo) acotado a sus unidades; la base
// exige las mismas reglas (20261020100000_claim_item_resolutions).

export const MIXED_CLAIM_RESOLUTION = "mixta"
export const MIXED_CLAIM_LABEL = "Solución por producto"

export function isMixedClaimResolution(resolution?: string | null) {
  return resolution === MIXED_CLAIM_RESOLUTION
}

export type ClaimLineSolution = "replacement" | "refund" | "credit"

/** Orden de presentación de las soluciones de una línea. */
export const CLAIM_LINE_SOLUTIONS: readonly ClaimLineSolution[] = ["replacement", "refund", "credit"]

export const CLAIM_LINE_SOLUTION_LABELS: Record<ClaimLineSolution, { label: string; action: string }> = {
  replacement: { label: "Reemplazo", action: "Reemplazar" },
  refund: { label: "Reintegro", action: "Reintegrar" },
  credit: { label: "Saldo a favor", action: "Saldo a favor" },
}

/** Destino de la NC que mueve el dinero de cada solución (reemplazo: ninguna). */
export const CLAIM_LINE_CREDIT_NOTE_DESTINATION: Record<ClaimLineSolution, "external_refund" | "customer_balance" | null> = {
  replacement: null,
  refund: "external_refund",
  credit: "customer_balance",
}

export interface ClaimItemResolutionRow {
  order_item_id: number
  solution: ClaimLineSolution
  quantity: number
}

export function isClaimLineSolution(value: unknown): value is ClaimLineSolution {
  return typeof value === "string" && (CLAIM_LINE_SOLUTIONS as readonly string[]).includes(value)
}

/** Solución por unidad de una resolución global (null: otra solución o sin decidir). */
export function getClaimLineSolution(resolution?: string | null): ClaimLineSolution | null {
  const requirements = getClaimRequirements(resolution)
  if (!requirements) return null
  if (requirements.solution === "replacement") return "replacement"
  if (requirements.financialAction === "refund") return "refund"
  if (requirements.financialAction === "customer_credit") return "credit"
  return null
}

type ClaimQuantitySource = ReadonlyArray<{ order_item_id: number | string; quantity: number | string }>

export interface ClaimResolutionLinesSource {
  resolution?: string | null
  affected_items?: ClaimQuantitySource | null
  order_claim_item_resolutions?: ReadonlyArray<{ order_item_id: number | string; solution: string; quantity: number | string }> | null
}

/**
 * Resolución por línea de cualquier reclamo. Mixto: su reparto. Simple
 * (incluido el histórico): la resolución global sobre todas las unidades
 * reclamadas.
 */
export function getClaimResolutionLines(claim: ClaimResolutionLinesSource): ClaimItemResolutionRow[] {
  if (isMixedClaimResolution(claim.resolution)) {
    return (claim.order_claim_item_resolutions ?? []).flatMap((row) =>
      isClaimLineSolution(row.solution) && Number(row.quantity) > 0
        ? [{ order_item_id: Number(row.order_item_id), solution: row.solution, quantity: Number(row.quantity) }]
        : [])
  }
  const solution = getClaimLineSolution(claim.resolution)
  if (!solution) return []
  return (claim.affected_items ?? [])
    .filter((item) => Number(item.quantity) > 0)
    .map((item) => ({ order_item_id: Number(item.order_item_id), solution, quantity: Number(item.quantity) }))
}

function quantitiesByItem(rows: ClaimQuantitySource) {
  const map = new Map<number, number>()
  for (const row of rows) map.set(Number(row.order_item_id), (map.get(Number(row.order_item_id)) ?? 0) + Number(row.quantity))
  return map
}

const LINE_SUMMARY_NOUNS: Record<ClaimLineSolution, [string, string]> = {
  replacement: ["reemplazo", "reemplazos"],
  refund: ["reintegro", "reintegros"],
  credit: ["saldo a favor", "saldo a favor"],
}

/** Resumen corto del reparto ("1 reemplazo · 1 reintegro"), para el cliente y el encabezado. */
export function getClaimLinesSummary(lines: ReadonlyArray<ClaimItemResolutionRow>) {
  return CLAIM_LINE_SOLUTIONS.flatMap((solution) => {
    const units = lines.filter((line) => line.solution === solution).reduce((sum, line) => sum + line.quantity, 0)
    if (units <= 0) return []
    const [one, many] = LINE_SUMMARY_NOUNS[solution]
    return [`${units} ${units === 1 ? one : many}`]
  }).join(" · ")
}

/** Unidades por ítem asignadas a una solución. */
export function getClaimLineQuantities(lines: ReadonlyArray<ClaimItemResolutionRow>, solution: ClaimLineSolution) {
  return quantitiesByItem(lines.filter((line) => line.solution === solution))
}

/**
 * Valida un reparto con las mismas reglas que la base: cantidades enteras,
 * sólo ítems reclamados, una fila por (ítem, solución) y nunca más unidades
 * que las reclamadas. `initial`: al definirlo, tiene que ser realmente mixto
 * (dos soluciones o unidades todavía sin definir).
 */
export function getClaimResolutionLinesError(
  affectedItems: ClaimQuantitySource,
  lines: ReadonlyArray<{ order_item_id: number; solution: string; quantity: number }>,
  options: { initial: boolean },
): string | null {
  const claimed = quantitiesByItem(affectedItems)
  if (!lines.length) return "Indicá qué solución recibe cada unidad."
  const seen = new Set<string>()
  for (const line of lines) {
    if (!isClaimLineSolution(line.solution) || !Number.isInteger(line.quantity) || line.quantity <= 0) return "Revisá las cantidades indicadas."
    if (!claimed.has(line.order_item_id)) return "Un producto indicado no forma parte del reclamo."
    const key = `${line.order_item_id}:${line.solution}`
    if (seen.has(key)) return "Cada solución se indica una sola vez por producto."
    seen.add(key)
  }
  for (const [itemId, quantity] of quantitiesByItem(lines)) {
    if (quantity > (claimed.get(itemId) ?? 0)) return "Hay más unidades resueltas que las reclamadas."
  }
  if (options.initial) {
    const total = lines.reduce((sum, line) => sum + line.quantity, 0)
    const claimedTotal = [...claimed.values()].reduce((sum, quantity) => sum + quantity, 0)
    if (new Set(lines.map((line) => line.solution)).size < 2 && total >= claimedTotal) {
      return "Con una sola solución para todas las unidades, elegila directamente."
    }
  }
  return null
}

/**
 * Cuántas unidades de cada ítem puede acreditar una NC de este reclamo con ese
 * destino. Simple: lo reclamado. Mixto: sólo lo asignado a reintegro
 * (external_refund) o a saldo (customer_balance); nunca las reemplazadas.
 */
export function getClaimCreditableQuantities(claim: ClaimResolutionLinesSource, destination: string): Map<number, number> {
  if (!isMixedClaimResolution(claim.resolution)) return quantitiesByItem(claim.affected_items ?? [])
  const solution = CLAIM_LINE_SOLUTIONS.find((value) => CLAIM_LINE_CREDIT_NOTE_DESTINATION[value] === destination)
  return solution ? getClaimLineQuantities(getClaimResolutionLines(claim), solution) : new Map()
}

/**
 * Resolución que guía las piezas físicas (logística, wizard, reemplazo). Un
 * mixto con alguna unidad a reemplazar sigue el circuito del reemplazo; si no,
 * el de la devolución para reintegro/saldo.
 */
export function getClaimOperationalResolution(
  resolution: string | null | undefined,
  lines: ReadonlyArray<ClaimItemResolutionRow>,
): string | null {
  if (!isMixedClaimResolution(resolution)) return resolution ?? null
  if (lines.some((line) => line.solution === "replacement")) return "cambio_producto"
  if (lines.some((line) => line.solution === "refund")) return "reintegro_total"
  if (lines.some((line) => line.solution === "credit")) return "saldo_a_favor"
  return null
}

/**
 * Entrada de la vista logística para cualquier reclamo (simple o mixto): la
 * resolución operativa y si admite cambio directo (un mixto no: el cambio en
 * sucursal entrega una unidad por cada original que retira).
 */
export function getClaimLogisticsResolution(claim: ClaimResolutionLinesSource) {
  return {
    resolution: getClaimOperationalResolution(claim.resolution, getClaimResolutionLines(claim)),
    allowExchange: !isMixedClaimResolution(claim.resolution),
  }
}

export type ClaimLineStage = "pending" | "processing" | "done"

export interface ClaimLineView {
  solution: ClaimLineSolution
  label: string
  quantity: number
  stage: ClaimLineStage
  stageLabel: string
  /** Lo que falta en esta línea (null si está completa). */
  missing: string | null
}

export interface ClaimItemResolutionView {
  orderItemId: number
  claimed: number
  /** Unidades reclamadas todavía sin solución. */
  unresolved: number
  lines: ClaimLineView[]
  complete: boolean
}

export interface MixedClaimView {
  items: ClaimItemResolutionView[]
  hasReplacement: boolean
  hasRefund: boolean
  hasCredit: boolean
  /** Unidades de reintegro / saldo todavía sin NC emitida o en proceso. */
  creditNotePending: { refund: number; credit: number }
  /**
   * El dinero externo (comprobante / refund) deja el pedido reintegrado y
   * bloquea NC posteriores: el saldo se emite primero (CLAIM_MIXED_CREDIT_FIRST).
   */
  refundWaitsForCredit: boolean
  blockers: string[]
  canClose: boolean
}

const MIXED_BLOCKER_ORDER = [
  "Unidades sin solución",
  "Verificando el reemplazo",
  "Falta registrar el reemplazo",
  "Saldo pendiente de acreditar",
  "Reintegro pendiente",
]

/**
 * Progreso por producto de un reclamo mixto: qué falta en cada línea, qué
 * acción financiera corresponde y si el reclamo completo puede cerrarse.
 * Mismas condiciones que order_claim_mixed_blockers.
 */
export function getMixedClaimView(input: {
  claimId: number
  affectedItems: ClaimQuantitySource
  lines: ReadonlyArray<ClaimItemResolutionRow>
  /** Reemplazos registrados del reclamo (netos de reversiones) por ítem; null = sin verificar. */
  replacedByItem: ReadonlyMap<number, number> | null
  /** Reemplazos entregados por ítem (unidades del reclamo); null = sin logística por unidades. */
  deliveredByItem?: ReadonlyMap<number, number> | null
  creditNotes?: ReadonlyArray<ClaimCreditNoteFact> | null
}): MixedClaimView {
  const notes = (input.creditNotes ?? []).filter((note) =>
    note.claim_id === input.claimId && (note.status === "processing" || note.status === "authorized"))
  const covered = (destination: string, itemId: number, settled: boolean) => notes
    .filter((note) => note.destination === destination &&
      (!settled || (note.status === "authorized" && note.settlement_status === "completado")))
    .flatMap((note) => note.order_credit_note_items ?? [])
    .filter((item) => Number(item.order_item_id) === itemId)
    .reduce((sum, item) => sum + Number(item.quantity), 0)
  const creditNotePending = { refund: 0, credit: 0 }
  const blockers = new Set<string>()

  const lineView = (itemId: number, line: ClaimItemResolutionRow): ClaimLineView => {
    const base = { solution: line.solution, label: CLAIM_LINE_SOLUTION_LABELS[line.solution].label, quantity: line.quantity }
    if (line.solution === "replacement") {
      const replaced = input.replacedByItem ? input.replacedByItem.get(itemId) ?? 0 : null
      if (replaced === null) {
        blockers.add("Verificando el reemplazo")
        return { ...base, stage: "pending", stageLabel: "Verificando", missing: "Verificando el reemplazo" }
      }
      if (replaced < line.quantity) {
        blockers.add("Falta registrar el reemplazo")
        return { ...base, stage: "pending", stageLabel: "Pendiente", missing: "Registrar reemplazo" }
      }
      const delivered = input.deliveredByItem ? input.deliveredByItem.get(itemId) ?? 0 : null
      if (delivered !== null && delivered < line.quantity) {
        return { ...base, stage: "processing", stageLabel: "En proceso", missing: "Entregar el reemplazo" }
      }
      return { ...base, stage: "done", stageLabel: delivered === null ? "Registrado" : "Entregado", missing: null }
    }
    const refund = line.solution === "refund"
    const destination = refund ? "external_refund" : "customer_balance"
    const settled = covered(destination, itemId, true)
    const issued = covered(destination, itemId, false)
    creditNotePending[refund ? "refund" : "credit"] += Math.max(0, line.quantity - issued)
    if (settled >= line.quantity) return { ...base, stage: "done", stageLabel: refund ? "Reintegrado" : "Acreditado", missing: null }
    blockers.add(refund ? "Reintegro pendiente" : "Saldo pendiente de acreditar")
    if (issued >= line.quantity) {
      return { ...base, stage: "processing", stageLabel: "En proceso", missing: refund ? "Registrar el reintegro" : "Acreditando el saldo" }
    }
    return { ...base, stage: "pending", stageLabel: "Pendiente", missing: refund ? "Calcular reintegro" : "Calcular saldo a favor" }
  }

  const items = [...quantitiesByItem(input.affectedItems)].map(([orderItemId, claimed]) => {
    const itemLines = input.lines
      .filter((line) => line.order_item_id === orderItemId)
      .sort((left, right) => CLAIM_LINE_SOLUTIONS.indexOf(left.solution) - CLAIM_LINE_SOLUTIONS.indexOf(right.solution))
    const assigned = itemLines.reduce((sum, line) => sum + line.quantity, 0)
    const unresolved = Math.max(0, claimed - assigned)
    if (unresolved > 0) blockers.add("Unidades sin solución")
    const lines = itemLines.map((line) => lineView(orderItemId, line))
    return { orderItemId, claimed, unresolved, lines, complete: unresolved === 0 && lines.every((line) => line.stage === "done") }
  })
  const has = (solution: ClaimLineSolution) => input.lines.some((line) => line.solution === solution)
  const list = MIXED_BLOCKER_ORDER.filter((blocker) => blockers.has(blocker))
  return {
    items,
    hasReplacement: has("replacement"),
    hasRefund: has("refund"),
    hasCredit: has("credit"),
    creditNotePending,
    refundWaitsForCredit: has("refund") && creditNotePending.credit > 0,
    blockers: list,
    canClose: list.length === 0,
  }
}

// ── Reemplazo sin stock ─────────────────────────────────────────────────────

export interface ReplacementSwitchState {
  available: boolean
  /** Por qué no puede cambiarse (null si puede o si no aplica). */
  blocker: string | null
}

const ACCEPTED_CLAIM_STATUSES = ["aprobado", "reintegro_pendiente", "cambio_pendiente", "cupon_pendiente"]

/**
 * ¿Puede un reemplazo pasar a reintegro o saldo (falta de stock)? Sólo
 * mientras sea reversible: sin envío del reemplazo iniciado, sin unidades
 * fuera de la reserva y con toda la reserva liberable. Mismas condiciones que
 * switch_order_claim_replacement_resolution (la base las vuelve a exigir).
 * Simple: todo el reclamo (orderItemId null). Mixto: la línea de ese producto.
 */
export function getReplacementSwitchState(input: {
  status: string
  resolution?: string | null
  lines: ReadonlyArray<ClaimItemResolutionRow>
  orderItemId: number | null
  shipments?: ReadonlyArray<{ direction: string; status?: string | null; creation_status?: string | null; review_required?: boolean | null }> | null
  units?: ReadonlyArray<{ role: string; location: string; order_item_id: number; shipment_id?: number | null; incident_open?: boolean | null }> | null
  /** Reemplazos registrados del reclamo (netos de reversiones) por ítem; null = sin verificar. */
  replacedByItem: ReadonlyMap<number, number> | null
}): ReplacementSwitchState {
  const unavailable = (blocker: string | null): ReplacementSwitchState => ({ available: false, blocker })
  if (!ACCEPTED_CLAIM_STATUSES.includes(input.status)) return unavailable(null)
  const mixed = isMixedClaimResolution(input.resolution)
  const itemId = input.orderItemId
  if (mixed) {
    if (itemId === null || !input.lines.some((line) => line.order_item_id === itemId && line.solution === "replacement")) {
      return unavailable(null)
    }
  } else if (getClaimRequirements(input.resolution)?.solution !== "replacement") {
    return unavailable(null)
  }
  const items = mixed && itemId !== null ? [itemId] : [...new Set(input.lines.map((line) => line.order_item_id))]
  const shipments = input.shipments ?? []
  const units = input.units ?? []
  if (shipments.some((row) => ["cambio", "reemplazo"].includes(row.direction) && row.status !== "cancelada" &&
      ["processing", "created", "manual_review"].includes(row.creation_status ?? "not_started")) ||
    units.some((unit) => unit.role === "reemplazo" && items.includes(unit.order_item_id) &&
      (["en_andreani", "entregada_cliente", "recibida_beyonix"].includes(unit.location) || (unit.location === "reservada" && Boolean(unit.shipment_id))))) {
    return unavailable("El reemplazo ya salió: la solución no se puede cambiar.")
  }
  if (units.some((unit) => unit.incident_open) || shipments.some((row) => row.review_required)) {
    return unavailable("Resolvé primero la incidencia abierta.")
  }
  if (!input.replacedByItem) return unavailable("Verificando el reemplazo.")
  for (const item of items) {
    const releasable = units.filter((unit) => unit.role === "reemplazo" && unit.order_item_id === item &&
      unit.location === "reservada" && !unit.shipment_id).length
    if ((input.replacedByItem.get(item) ?? 0) > releasable) {
      return unavailable("El reemplazo registrado ya descontó stock sin una reserva que pueda liberarse.")
    }
  }
  return { available: true, blocker: null }
}
