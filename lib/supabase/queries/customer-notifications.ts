import { supabase } from "@/lib/supabase/client"
import type { SupabaseCustomerNotification } from "@/lib/supabase/types"

const CUSTOMER_NOTIFICATION_LIMIT = 8

interface PaymentNotificationOrder {
  id: number
  payment_method_id?: string | null
  payment_status?: string | null
  estado?: string | null
  financial_status?: string | null
  payment_proof_url?: string | null
  payment_proof_uploaded_at?: string | null
}

const PAYMENT_NOTIFICATION_TYPES = new Set([
  "payment_proof_pending",
  "payment_proof_received",
  "payment_validated",
])

const ORDER_PROGRESS_NOTIFICATION_TYPES = new Set([
  ...PAYMENT_NOTIFICATION_TYPES,
  "order_status",
  "order_cancelled",
  "refund_pending",
])

function getOrderCode(orderId: number) {
  return `BX-${1000 + orderId}`
}

function isOrderCancelled(order: PaymentNotificationOrder) {
  return (
    (order.estado ?? "").toLowerCase() === "cancelado" ||
    ["cancelled", "cancellation_requested", "refund_pending"].includes(
      order.financial_status ?? "",
    )
  )
}

function normalizeCancelledOrderNotification(
  notification: SupabaseCustomerNotification,
  order: PaymentNotificationOrder,
) {
  const needsRefund = ["cancellation_requested", "refund_pending"].includes(
    order.financial_status ?? "",
  )
  const orderCode = getOrderCode(order.id)

  return {
    ...notification,
    type: "order_cancelled",
    title: "Pedido cancelado",
    body: needsRefund
      ? `Tu pedido ${orderCode} fue cancelado correctamente. Estamos gestionando el reintegro correspondiente.`
      : `Tu pedido ${orderCode} fue cancelado correctamente.`,
    action_url: `/cuenta/compras/${order.id}`,
  }
}

function isPaymentConfirmed(order: PaymentNotificationOrder) {
  return (
    order.payment_status === "confirmado" ||
    order.payment_status === "approved" ||
    order.estado === "pagado"
  )
}

function hasPaymentProof(order: PaymentNotificationOrder) {
  return Boolean(order.payment_proof_url || order.payment_proof_uploaded_at)
}

function normalizePaymentNotification(
  notification: SupabaseCustomerNotification,
  order: PaymentNotificationOrder,
) {
  if (isOrderCancelled(order)) {
    return normalizeCancelledOrderNotification(notification, order)
  }

  if (order.payment_method_id !== "transferencia") return notification

  if (isPaymentConfirmed(order)) {
    return {
      ...notification,
      type: "payment_validated",
      title: "Pago confirmado",
      body: "Tu pago fue confirmado correctamente.",
    }
  }

  if (hasPaymentProof(order)) {
    return {
      ...notification,
      type: "payment_proof_received",
      title: "Comprobante recibido",
      body: "Recibimos tu comprobante y estamos revisando el pago.",
    }
  }

  return {
    ...notification,
    type: "payment_proof_pending",
    title: "Comprobante pendiente",
    body: "Subí el comprobante para que podamos confirmar tu pago.",
  }
}

function normalizeOrderProgressNotification(
  notification: SupabaseCustomerNotification,
  order: PaymentNotificationOrder,
) {
  if (isOrderCancelled(order)) {
    return normalizeCancelledOrderNotification(notification, order)
  }

  if (PAYMENT_NOTIFICATION_TYPES.has(notification.type)) {
    return normalizePaymentNotification(notification, order)
  }

  return notification
}

function getOrderProgressNotificationPriority(
  notification: SupabaseCustomerNotification,
) {
  if (notification.type === "order_cancelled") return 4
  if (notification.type === "refund_pending") return 4
  if (notification.type === "order_status") return 4
  if (notification.type === "payment_validated") return 3
  if (notification.type === "payment_proof_received") return 2
  if (notification.type === "payment_proof_pending") return 1
  return 0
}

function removeContradictoryOrderProgressNotifications(
  notifications: SupabaseCustomerNotification[],
) {
  const bestNotificationByOrder = new Map<
    number,
    SupabaseCustomerNotification
  >()

  for (const notification of notifications) {
    if (
      !notification.order_id ||
      !ORDER_PROGRESS_NOTIFICATION_TYPES.has(notification.type)
    ) {
      continue
    }

    const current = bestNotificationByOrder.get(notification.order_id)

    if (
      !current ||
      getOrderProgressNotificationPriority(notification) >
        getOrderProgressNotificationPriority(current) ||
      (
        getOrderProgressNotificationPriority(notification) ===
          getOrderProgressNotificationPriority(current) &&
        new Date(notification.created_at).getTime() >
          new Date(current.created_at).getTime()
      )
    ) {
      bestNotificationByOrder.set(notification.order_id, notification)
    }
  }

  return notifications.filter((notification) => {
    if (
      !notification.order_id ||
      !ORDER_PROGRESS_NOTIFICATION_TYPES.has(notification.type)
    ) {
      return true
    }

    return bestNotificationByOrder.get(notification.order_id)?.id === notification.id
  })
}

export async function getCustomerNotifications(userId: string) {
  const now = new Date().toISOString()
  const { data, error } = await supabase
    .from("customer_notifications")
    .select("id, user_id, type, title, body, action_url, order_id, is_read, source_key, target_items, starts_at, ends_at, dismissed_at, created_at")
    .eq("user_id", userId)
    .is("dismissed_at", null)
    .or(`starts_at.is.null,starts_at.lte.${now}`)
    .or(`ends_at.is.null,ends_at.gt.${now}`)
    .order("created_at", { ascending: false })
    .limit(CUSTOMER_NOTIFICATION_LIMIT)

  if (error) throw error

  const notifications = (data ?? []) as SupabaseCustomerNotification[]
  const orderProgressNotificationOrderIds = [
    ...new Set(
      notifications
        .filter(
          (notification) =>
            notification.order_id &&
            ORDER_PROGRESS_NOTIFICATION_TYPES.has(notification.type),
        )
        .map((notification) => notification.order_id as number),
    ),
  ]

  if (orderProgressNotificationOrderIds.length === 0) {
    return notifications
  }

  const { data: orders, error: ordersError } = await supabase
    .from("ordenes")
    .select(
      "id, payment_method_id, payment_status, estado, financial_status, payment_proof_url, payment_proof_uploaded_at",
    )
    .in("id", orderProgressNotificationOrderIds)

  if (ordersError) throw ordersError

  const ordersById = new Map(
    ((orders ?? []) as PaymentNotificationOrder[]).map((order) => [
      order.id,
      order,
    ]),
  )

  return removeContradictoryOrderProgressNotifications(
    notifications.map((notification) => {
      const order = notification.order_id
        ? ordersById.get(notification.order_id)
        : null

      if (!order || !ORDER_PROGRESS_NOTIFICATION_TYPES.has(notification.type)) {
        return notification
      }

      return normalizeOrderProgressNotification(notification, order)
    }),
  )
}

export async function markCustomerNotificationRead(
  notificationId: string,
  userId: string,
) {
  const { error } = await supabase
    .from("customer_notifications")
    .update({ is_read: true })
    .eq("id", notificationId)
    .eq("user_id", userId)

  if (error) throw error
}

export async function markAllCustomerNotificationsRead(userId: string) {
  const { error } = await supabase
    .from("customer_notifications")
    .update({ is_read: true })
    .eq("user_id", userId)
    .eq("is_read", false)

  if (error) throw error
}

export async function dismissReadCustomerNotifications(userId: string) {
  const { error } = await supabase
    .from("customer_notifications")
    .update({ dismissed_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("is_read", true)
    .is("dismissed_at", null)
    .not("source_key", "like", "campaign:%")

  if (error) throw error
}
