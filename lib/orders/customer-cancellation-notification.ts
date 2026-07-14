import "server-only"

import type { createAdminClient } from "@/lib/supabase/admin"

type AdminClient = ReturnType<typeof createAdminClient>

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

export function buildCustomerCancelledOrderNotification(
  order: CustomerCancelledOrderNotificationSource,
) {
  const orderCode = getOrderCode(order.id)
  const body = cancellationNeedsRefund(order)
    ? `Tu pedido ${orderCode} fue cancelado correctamente. Estamos gestionando el reintegro correspondiente.`
    : `Tu pedido ${orderCode} fue cancelado correctamente.`

  return {
    type: "order_cancelled",
    title: "Pedido cancelado",
    body,
    action_url: `/cuenta/compras/${order.id}`,
    order_id: order.id,
    source_key: `order:${order.id}:cancelled`,
  }
}

export async function upsertCustomerCancelledOrderNotification(
  admin: AdminClient,
  order: CustomerCancelledOrderNotificationSource,
) {
  if (!order.usuario_id) return

  const notification = buildCustomerCancelledOrderNotification(order)

  const { error } = await admin.from("customer_notifications").upsert(
    {
      user_id: order.usuario_id,
      ...notification,
      is_read: false,
      created_at: new Date().toISOString(),
    },
    { onConflict: "source_key" },
  )

  if (error && error.code !== "23505") {
    console.log("No se pudo crear notificación de cancelación", error.message)
  }
}
