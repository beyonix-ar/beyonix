import { claimAllowsCreditNote, getClaimCreditableQuantities, isMixedClaimResolution } from "./claim-policy.ts"
import { operationRequiresClaim } from "./credit-note-wizard.ts"

export interface CreditNoteClaimPolicyClaim {
  id: number
  order_id: number
  user_id?: string | null
  status?: string | null
  failure_type?: string | null
  resolution?: string | null
  affected_items?: Array<{
    order_item_id: number
    quantity: number
  }> | null
  /** Reclamo mixto: unidades por solución (reemplazo, reintegro, saldo). */
  order_claim_item_resolutions?: Array<{
    order_item_id: number
    solution: string
    quantity: number
  }> | null
}

interface CreditNoteClaimPolicyInput {
  operationType: string
  actorRole: string
  orderId: number
  orderUserId?: string | null
  claim: CreditNoteClaimPolicyClaim | null
  selectedItems: Array<{ order_item_id: number; quantity: number }>
  /** Destino del dinero: en un reclamo mixto define qué unidades puede acreditar. */
  destination?: string | null
  /**
   * El pedido se canceló directamente desde Admin (admin_cancel_order,
   * auditado): no existe reclamo del cliente. Misma evidencia que exige la
   * base (order_has_admin_direct_cancellation).
   */
  adminDirectCancellation?: boolean
}

export function isAdministrativeCreditNoteOperation(operationType: string) {
  return !operationRequiresClaim(operationType)
}

// Además del estado, la solución tiene que mover dinero: un reemplazo nunca
// habilita el asistente de nota de crédito (claim-policy.ts).
export function isClaimEligibleForCreditNote(
  claim: Pick<CreditNoteClaimPolicyClaim, "status" | "failure_type" | "resolution">,
) {
  return (
    claimAllowsCreditNote(claim) &&
    [
      "aprobado",
      "reintegro_pendiente",
      "cambio_pendiente",
      "cupon_pendiente",
      "reemplazo_enviado",
    ].includes(claim.status ?? "") &&
    claim.resolution !== "rechazado" &&
    claim.failure_type !== "consulta_pedido"
  )
}

export function getCreditNoteClaimPolicyError({
  operationType,
  actorRole,
  orderId,
  orderUserId,
  claim,
  selectedItems,
  destination = null,
  adminDirectCancellation = false,
}: CreditNoteClaimPolicyInput): string | null {
  if (isAdministrativeCreditNoteOperation(operationType)) {
    if (actorRole !== "super_admin") {
      return "Solo un superadministrador puede emitir una nota de crédito administrativa sin reclamo."
    }
    if (claim) {
      return "Un ajuste administrativo debe registrarse separado de los reclamos del cliente."
    }
    if (selectedItems.length > 0) {
      return "Un ajuste administrativo sin reclamo no puede devolver productos ni modificar stock."
    }
    return null
  }

  if (!claim) {
    // La venta se facturó después de una cancelación hecha por Admin: la NC
    // de esa cancelación se autoriza con la auditoría, no con un reclamo.
    if (operationType === "cancelacion_antes_despacho" && adminDirectCancellation) return null
    return "Esta gestión requiere un reclamo del cliente para el pedido."
  }
  if (claim.order_id !== orderId) {
    return "El reclamo seleccionado no corresponde a este pedido."
  }
  if (orderUserId && claim.user_id !== orderUserId) {
    return "El reclamo seleccionado no corresponde al cliente del pedido."
  }
  if (!claimAllowsCreditNote(claim)) {
    return "La solución del reclamo no incluye reintegro ni saldo a favor: no corresponde nota de crédito."
  }
  if (!isClaimEligibleForCreditNote(claim)) {
    return "El reclamo seleccionado no está habilitado para una devolución o reintegro."
  }
  if (
    operationType === "cancelacion_antes_despacho" &&
    claim.failure_type !== "cancelar_compra"
  ) {
    return "La cancelación debe estar asociada a una solicitud de cancelación del cliente."
  }
  if (
    operationType !== "cancelacion_antes_despacho" &&
    claim.failure_type === "cancelar_compra"
  ) {
    return "La solicitud de cancelación no autoriza una devolución de productos."
  }

  // Reclamo mixto: la NC toma sólo las unidades de reintegro (external_refund)
  // o de saldo (customer_balance), nunca las reemplazadas ni el total del
  // reclamo (guard_mixed_claim_credit_note_item vuelve a exigirlo).
  const mixed = isMixedClaimResolution(claim.resolution)
  if (mixed && selectedItems.length === 0) {
    return "Indicá los productos del reintegro o del saldo a favor."
  }
  const affectedItems = getClaimCreditableQuantities(claim, destination ?? "")
  if (mixed && affectedItems.size === 0) {
    return destination === "external_refund"
      ? "Este reclamo no tiene unidades a reintegrar."
      : "Este reclamo no tiene unidades con saldo a favor."
  }
  for (const item of selectedItems) {
    const affectedQuantity = affectedItems.get(item.order_item_id) ?? 0
    if (affectedQuantity < item.quantity) {
      return "La nota de crédito incluye un producto o cantidad que no forma parte del reclamo."
    }
  }

  return null
}
