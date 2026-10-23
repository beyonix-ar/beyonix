import "server-only"

export interface CustomerCancelledOrderNotificationSource {
  id: number
  usuario_id?: string | null
  financial_status?: string | null
}

function getOrderCode(orderId: number) {
  return `BX-${1000 + orderId}`
}

function cancellationNeedsRefund(order: CustomerCancelledOrderNotificationSource) {
  return ["cancellation_requested", "refund_pending"].includes(
    order.financial_status ?? "",
  )
}

/**
 * Texto del email de cancelación. La campana la escribe la base
 * (notify_customer_order_cancelled) con el mismo mensaje.
 */
export function buildCustomerCancelledOrderNotification(
  order: CustomerCancelledOrderNotificationSource,
) {
  const orderCode = getOrderCode(order.id)
  const body = cancellationNeedsRefund(order)
    ? `recibimos la cancelación de tu pedido ${orderCode}. Te avisamos cuando el reintegro esté listo.`
    : `recibimos la cancelación de tu pedido ${orderCode}.`

  return {
    type: "order_cancelled",
    title: "Cancelación recibida",
    body,
    action_url: `/cuenta/compras/${order.id}`,
    order_id: order.id,
    source_key: `order:${order.id}:cancelled`,
  }
}
