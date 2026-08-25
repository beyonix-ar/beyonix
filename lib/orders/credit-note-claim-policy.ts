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
}

interface CreditNoteClaimPolicyInput {
  operationType: string
  actorRole: string
  orderId: number
  orderUserId?: string | null
  claim: CreditNoteClaimPolicyClaim | null
  selectedItems: Array<{ order_item_id: number; quantity: number }>
}

export function isAdministrativeCreditNoteOperation(operationType: string) {
  return !operationRequiresClaim(operationType)
}

export function isClaimEligibleForCreditNote(
  claim: Pick<CreditNoteClaimPolicyClaim, "status" | "failure_type" | "resolution">,
) {
  return (
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
    return "Esta gestión requiere un reclamo del cliente para el pedido."
  }
  if (claim.order_id !== orderId) {
    return "El reclamo seleccionado no corresponde a este pedido."
  }
  if (orderUserId && claim.user_id !== orderUserId) {
    return "El reclamo seleccionado no corresponde al cliente del pedido."
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

  const affectedItems = new Map(
    (claim.affected_items ?? []).map((item) => [
      Number(item.order_item_id),
      Number(item.quantity),
    ]),
  )
  for (const item of selectedItems) {
    const affectedQuantity = affectedItems.get(item.order_item_id) ?? 0
    if (affectedQuantity < item.quantity) {
      return "La nota de crédito incluye un producto o cantidad que no forma parte del reclamo."
    }
  }

  return null
}
