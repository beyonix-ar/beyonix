import type { SupabasePedido } from "@/lib/supabase/types"

export const ORDER_NOTIFICATIONS_CHANGED_EVENT =
  "beyonix:order-notifications-changed"

const ATTENTION_PAYMENT_STATUSES = new Set([
  "pendiente_comprobante",
  "en_revision",
])

const FINAL_ORDER_STATES = new Set([
  "cancelado",
  "entregado",
  "finalizado",
])

export function orderNeedsAdminAttention(
  order: Pick<SupabasePedido, "estado" | "payment_status">
) {
  const status = order.estado?.toLowerCase()
  const paymentStatus = order.payment_status?.toLowerCase() ?? ""

  if (FINAL_ORDER_STATES.has(status)) return false

  return status === "pendiente" || ATTENTION_PAYMENT_STATUSES.has(paymentStatus)
}

export function getOrderNotificationCount(
  orders: Pick<SupabasePedido, "estado" | "payment_status">[]
) {
  return orders.filter(orderNeedsAdminAttention).length
}

export function notifyOrderNotificationsChanged() {
  if (typeof window === "undefined") return

  window.dispatchEvent(new Event(ORDER_NOTIFICATIONS_CHANGED_EVENT))
}
