import "server-only"

import type { createAdminClient } from "@/lib/supabase/admin"
import type { SupabasePedido } from "@/lib/supabase/types"
import { appendOrderAuditEvent } from "@/lib/orders/order-audit"

type AdminClient = ReturnType<typeof createAdminClient>

export const TRANSFER_PAYMENT_EXPIRATION_HOURS = 48
export const TRANSFER_PAYMENT_EXPIRED_STATUS = "vencido_falta_comprobante"

const EXPIRABLE_PAYMENT_STATUSES = new Set([
  "pendiente_comprobante",
  "pending",
])

function getExpirationCutoff(now = new Date()) {
  return new Date(
    now.getTime() - TRANSFER_PAYMENT_EXPIRATION_HOURS * 60 * 60 * 1000,
  )
}

export function isTransferOrderExpiredWithoutProof(
  order: Pick<
    SupabasePedido,
    | "created_at"
    | "estado"
    | "payment_method_id"
    | "payment_status"
    | "payment_proof_url"
    | "payment_proof_uploaded_at"
  >,
  now = new Date(),
) {
  if (order.payment_method_id !== "transferencia") return false
  if ((order.estado ?? "").toLowerCase() === "cancelado") return false
  if (order.payment_proof_url || order.payment_proof_uploaded_at) return false
  if (!EXPIRABLE_PAYMENT_STATUSES.has(order.payment_status ?? "")) return false

  const createdAt = new Date(order.created_at).getTime()
  if (!Number.isFinite(createdAt)) return false

  return createdAt <= getExpirationCutoff(now).getTime()
}

export async function expireTransferOrderIfNeeded(
  admin: AdminClient,
  order: SupabasePedido,
  now = new Date(),
) {
  if (!isTransferOrderExpiredWithoutProof(order, now)) return order

  const expiredAt = now.toISOString()
  const previousStatus =
    order.financial_status ?? order.payment_status ?? "pending_payment"

  const { data: updatedOrder, error } = await admin
    .from("ordenes")
    .update({
      estado: "cancelado",
      payment_status: TRANSFER_PAYMENT_EXPIRED_STATUS,
      financial_status: "cancelled",
      cancelled_at: expiredAt,
    })
    .eq("id", order.id)
    .eq("payment_method_id", "transferencia")
    .in("payment_status", Array.from(EXPIRABLE_PAYMENT_STATUSES))
    .is("payment_proof_url", null)
    .is("payment_proof_uploaded_at", null)
    .neq("estado", "cancelado")
    .select()
    .maybeSingle()

  if (error || !updatedOrder) {
    if (error) {
      console.warn("TRANSFER_ORDER_EXPIRATION_ERROR", {
        orderId: order.id,
        message: error.message,
      })
    }

    return order
  }

  await appendOrderAuditEvent(admin, {
    orderId: order.id,
    actorType: "system",
    action: "order_auto_cancelled_payment_timeout",
    previousStatus,
    newStatus: "cancelled",
    metadata: {
      reason: "payment_proof_timeout",
      expiredAt,
      expirationHours: TRANSFER_PAYMENT_EXPIRATION_HOURS,
    },
  })

  return updatedOrder as SupabasePedido
}

export async function expireOverdueTransferOrders(
  admin: AdminClient,
  options: { userId?: string | null } = {},
) {
  const cutoff = getExpirationCutoff().toISOString()

  let query = admin
    .from("ordenes")
    .select("*")
    .eq("payment_method_id", "transferencia")
    .in("payment_status", Array.from(EXPIRABLE_PAYMENT_STATUSES))
    .is("payment_proof_url", null)
    .is("payment_proof_uploaded_at", null)
    .neq("estado", "cancelado")
    .lte("created_at", cutoff)

  if (options.userId) {
    query = query.eq("usuario_id", options.userId)
  }

  const { data: orders, error } = await query

  if (error) {
    console.warn("TRANSFER_OVERDUE_ORDERS_LOAD_ERROR", {
      message: error.message,
    })
    return 0
  }

  let expiredCount = 0

  for (const order of (orders ?? []) as SupabasePedido[]) {
    const updatedOrder = await expireTransferOrderIfNeeded(admin, order)
    if (updatedOrder.estado === "cancelado" && order.estado !== "cancelado") {
      expiredCount += 1
    }
  }

  return expiredCount
}
