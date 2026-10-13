import { isOrderPaymentConfirmed, type OrderPaymentConfirmationRow } from "./order-payment-status.ts"

/**
 * Estado financiero de un pedido cancelado: única fuente de verdad para
 * Cliente (Mis compras, detalle, timeline) y Admin (badge de RESUMEN). Se
 * deriva de columnas reales de ordenes -- nunca de un estado nuevo:
 *   estado / financial_status   ciclo de cancelación y reintegro
 *   payment_status / paid_at    si hubo un cobro real que devolver
 */
export type OrderCancellationRefundState = "cancelled" | "refund_in_progress" | "refunded"

export type OrderCancellationRefundFields = OrderPaymentConfirmationRow & {
  estado?: string | null
}

/**
 * null: el pedido no está cancelado (sigue su flujo normal). Sólo
 * estado='cancelado' define la cancelación: un reintegro por reclamo después
 * de la entrega también usa refund_pending/refunded y no es un pedido cancelado.
 */
export function getOrderCancellationRefundState(
  order: OrderCancellationRefundFields,
): OrderCancellationRefundState | null {
  if ((order.estado ?? "").toLowerCase() !== "cancelado") return null
  const financialStatus = order.financial_status ?? ""

  if (financialStatus === "refunded") return "refunded"
  if (financialStatus === "refund_pending") return "refund_in_progress"
  // Pago real recibido con el pedido ya cancelado: se está devolviendo.
  if (order.payment_status === "approved_after_cancellation") return "refund_in_progress"
  // Cancelado sin cobro (o checkout nunca pagado): no hay nada que devolver.
  if (financialStatus === "cancelled") return "cancelled"
  return isOrderPaymentConfirmed(order) ? "refund_in_progress" : "cancelled"
}

export const ORDER_CANCELLATION_REFUND_LABELS: Record<
  OrderCancellationRefundState,
  { customer: string; admin: string }
> = {
  cancelled: { customer: "Pedido cancelado", admin: "Cancelado" },
  refund_in_progress: { customer: "Reintegro en proceso", admin: "Cancelado · Reintegro en proceso" },
  refunded: { customer: "Reintegro realizado", admin: "Cancelado · Reintegrado" },
}
