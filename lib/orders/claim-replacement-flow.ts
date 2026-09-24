// Presentación del flujo operativo de un reclamo en el admin (panel
// "Gestionar reclamo" y stepper de "Recepción del producto original").
// Sólo deriva estados visuales desde datos existentes: no decide reglas de
// negocio. Las validaciones reales (stock, recepción, reemplazos, cierre)
// siguen en los endpoints/RPC correspondientes.

export type ClaimStepState = "done" | "current" | "pending"

export interface ClaimProgressStep {
  key: "decision" | "reception" | "credit_note" | "refund" | "replacement" | "delivery"
  label: string
  state: ClaimStepState
}

export interface RegisteredReplacement {
  original_order_id?: number
  claim_id?: number | null
  original_order_item_id: number
  quantity: number
}

export type ReplacementLoadState = "loading" | "error" | "ready"

type ReplacementClaim = {
  id: number
  order_id: number
  failure_type?: string | null
  affected_items?: { order_item_id: number; quantity: number }[] | null
}

// Para cambios, sólo cuentan ítems explícitos del reclamo. Un registro sin
// claim_id es utilizable únicamente si no hay otro reclamo formal del pedido.
export function sumClaimReplacedUnits(
  replacements: RegisteredReplacement[] | null | undefined,
  claim: ReplacementClaim,
  orderClaims: ReplacementClaim[],
): number | null {
  if (!replacements) return null
  const items = new Set((claim.affected_items ?? [])
    .filter((item) => Number.isInteger(item.order_item_id) && item.quantity > 0)
    .map((item) => item.order_item_id))
  const formalClaims = orderClaims.filter((candidate) =>
    candidate.order_id === claim.order_id &&
    !["consulta_pedido", "cancelar_compra"].includes(candidate.failure_type ?? ""))
  const allowHistorical = formalClaims.length === 1 && formalClaims[0].id === claim.id
  return replacements.filter((row) =>
    row.original_order_id === claim.order_id && items.has(row.original_order_item_id) &&
    (row.claim_id === claim.id || (row.claim_id === null && allowHistorical)))
    .reduce((sum, row) => sum + (Number.isFinite(row.quantity) && row.quantity > 0 ? row.quantity : 0), 0)
}

export function sumReplacedUnits(
  replacements: RegisteredReplacement[] | null | undefined,
  orderItemIds: number[],
): number | null {
  if (!replacements) return null
  const ids = new Set(orderItemIds)
  return replacements
    .filter((row) => ids.has(Number(row.original_order_item_id)))
    .reduce((sum, row) => sum + Number(row.quantity || 0), 0)
}

export function isReplacementResolution(resolution?: string | null) {
  return resolution === "cambio_producto" || resolution === "envio_unidad_faltante"
}

// Una unidad faltante nunca volvió al depósito: no hay recepción previa.
export function requiresOriginalReception(resolution?: string | null) {
  return resolution === "cambio_producto"
}

function isReplacementDelivered(status: string) {
  return status === "cerrado" || status === "reemplazo_enviado"
}

export interface ReplacementFlowInput {
  status: string
  resolution?: string | null
  claimedUnits: number
  receivedUnits: number
  /** Unidades con salida de stock registrada. null = desconocido (sin permiso o todavía cargando). */
  replacedUnits: number | null
  replacementLoadState?: ReplacementLoadState
}

export interface ReplacementFlow {
  requiresReception: boolean
  reception: ClaimStepState
  replacement: ClaimStepState
  delivery: ClaimStepState
  canRegisterReplacement: boolean
  canConfirmDelivery: boolean
}

export function getReplacementFlow(input: ReplacementFlowInput): ReplacementFlow {
  const requiresReception = requiresOriginalReception(input.resolution)
  const delivered = isReplacementDelivered(input.status)
  const receptionDone = input.claimedUnits > 0 && input.receivedUnits >= input.claimedUnits
  const replacementStarted = input.replacedUnits !== null && input.replacedUnits > 0
  const replacementDone =
    input.replacedUnits !== null && input.replacedUnits >= Math.max(1, input.claimedUnits)
  // El registro de reemplazo admite hasta lo ya recibido (o garantía sin
  // recepción, desde la propia sección de Reemplazos).
  const canRegisterReplacement =
    !delivered && (!requiresReception || input.receivedUnits > 0 || replacementStarted)
  // Sólo Cambio de producto exige evidencia positiva y una carga verificada.
  const canConfirmDelivery = !delivered && (requiresReception
    ? replacementStarted && (!input.replacementLoadState || input.replacementLoadState === "ready")
    : input.replacedUnits === null || replacementStarted)

  const reception: ClaimStepState = !requiresReception || receptionDone ? "done" : "current"
  const replacement: ClaimStepState = replacementDone
    ? "done"
    : canRegisterReplacement
      ? "current"
      : "pending"
  const delivery: ClaimStepState = delivered
    ? "done"
    : replacementStarted
      ? "current"
      : "pending"

  return {
    requiresReception,
    reception,
    replacement,
    delivery,
    canRegisterReplacement,
    canConfirmDelivery,
  }
}

export interface ClaimProgressInput extends ReplacementFlowInput {
  creditNoteAuthorized: boolean
  refundCompleted: boolean
}

// Stepper compacto: el primer paso incompleto es el actual; los siguientes,
// pendientes. Mismas condiciones de completitud que el progreso anterior.
export function getClaimProgressSteps(input: ClaimProgressInput): ClaimProgressStep[] {
  const resolution = input.resolution ?? ""
  const decided = Boolean(resolution) && resolution !== "rechazado"
  const receptionDone = input.claimedUnits > 0 && input.receivedUnits >= input.claimedUnits
  const steps: Array<Omit<ClaimProgressStep, "state"> & { complete: boolean }> = [
    { key: "decision", label: "Decisión", complete: decided },
  ]

  if (!isReplacementResolution(resolution) || requiresOriginalReception(resolution)) {
    steps.push({ key: "reception", label: "Recepción", complete: receptionDone })
  }

  if (["reintegro_total", "reintegro_parcial", "cupon_descuento", "saldo_a_favor"].includes(resolution)) {
    steps.push({ key: "credit_note", label: "Nota de crédito", complete: input.creditNoteAuthorized })
    if (resolution === "reintegro_total" || resolution === "reintegro_parcial") {
      steps.push({ key: "refund", label: "Reintegro", complete: input.refundCompleted })
    }
  }

  if (isReplacementResolution(resolution)) {
    const delivered = isReplacementDelivered(input.status)
    const replaced =
      input.replacedUnits !== null && input.replacedUnits >= Math.max(1, input.claimedUnits)
    steps.push({ key: "replacement", label: "Reemplazo", complete: replaced })
    steps.push({ key: "delivery", label: "Entrega", complete: delivered })
  }

  const current = steps.findIndex((step) => !step.complete)
  return steps.map(({ complete, ...step }, index) => ({
    ...step,
    state: complete ? "done" : index === current ? "current" : "pending",
  }))
}
