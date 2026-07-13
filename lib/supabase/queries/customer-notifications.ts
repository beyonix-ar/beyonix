import { supabase } from "@/lib/supabase/client"
import type { SupabaseCustomerNotification } from "@/lib/supabase/types"

interface PaymentNotificationOrder {
  id: number
  payment_method_id?: string | null
  payment_status?: string | null
  estado?: string | null
  payment_proof_url?: string | null
  payment_proof_uploaded_at?: string | null
}

const PAYMENT_NOTIFICATION_TYPES = new Set([
  "payment_proof_pending",
  "payment_proof_received",
  "payment_validated",
])

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

function getPaymentNotificationPriority(notification: SupabaseCustomerNotification) {
  if (notification.type === "payment_validated") return 3
  if (notification.type === "payment_proof_received") return 2
  if (notification.type === "payment_proof_pending") return 1
  return 0
}

function removeContradictoryPaymentNotifications(
  notifications: SupabaseCustomerNotification[],
) {
  const bestPaymentNotificationByOrder = new Map<
    number,
    SupabaseCustomerNotification
  >()

  for (const notification of notifications) {
    if (
      !notification.order_id ||
      !PAYMENT_NOTIFICATION_TYPES.has(notification.type)
    ) {
      continue
    }

    const current = bestPaymentNotificationByOrder.get(notification.order_id)

    if (
      !current ||
      getPaymentNotificationPriority(notification) >
        getPaymentNotificationPriority(current) ||
      (
        getPaymentNotificationPriority(notification) ===
          getPaymentNotificationPriority(current) &&
        new Date(notification.created_at).getTime() >
          new Date(current.created_at).getTime()
      )
    ) {
      bestPaymentNotificationByOrder.set(notification.order_id, notification)
    }
  }

  return notifications.filter((notification) => {
    if (
      !notification.order_id ||
      !PAYMENT_NOTIFICATION_TYPES.has(notification.type)
    ) {
      return true
    }

    return bestPaymentNotificationByOrder.get(notification.order_id)?.id === notification.id
  })
}

export async function getCustomerNotifications(userId: string) {
  const { data, error } = await supabase
    .from("customer_notifications")
    .select("id, user_id, type, title, body, action_url, order_id, is_read, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(30)

  if (error) throw error

  const notifications = (data ?? []) as SupabaseCustomerNotification[]
  const paymentNotificationOrderIds = [
    ...new Set(
      notifications
        .filter(
          (notification) =>
            notification.order_id &&
            PAYMENT_NOTIFICATION_TYPES.has(notification.type),
        )
        .map((notification) => notification.order_id as number),
    ),
  ]

  if (paymentNotificationOrderIds.length === 0) {
    return notifications
  }

  const { data: orders, error: ordersError } = await supabase
    .from("ordenes")
    .select(
      "id, payment_method_id, payment_status, estado, payment_proof_url, payment_proof_uploaded_at",
    )
    .in("id", paymentNotificationOrderIds)

  if (ordersError) throw ordersError

  const ordersById = new Map(
    ((orders ?? []) as PaymentNotificationOrder[]).map((order) => [
      order.id,
      order,
    ]),
  )

  return removeContradictoryPaymentNotifications(
    notifications.map((notification) => {
      const order = notification.order_id
        ? ordersById.get(notification.order_id)
        : null

      if (!order || !PAYMENT_NOTIFICATION_TYPES.has(notification.type)) {
        return notification
      }

      return normalizePaymentNotification(notification, order)
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
