import "server-only"

import type { createAdminClient } from "@/lib/supabase/admin"
import type { SupabasePedido } from "@/lib/supabase/types"
import { appendOrderAuditEvent } from "./order-audit.ts"
import { reverseCustomerCreditForOrder } from "../customer-credit/server.ts"
import { restoreStoreBenefitFromSupersededOrder } from "../customer-store-benefits.ts"

type AdminClient = ReturnType<typeof createAdminClient>

/**
 * Ventana TÉCNICA de conciliación de una transferencia (detección tardía y
 * cierre administrativo del pedido sin pago). El plazo comercial para pagar
 * con stock garantizado es la reserva de 20 minutos del Paso 3
 * (lib/orders/transfer-reservation-window.ts); el stock nunca queda reservado
 * durante esta ventana.
 */
export const TRANSFER_PAYMENT_EXPIRATION_HOURS = 48
export const TRANSFER_PAYMENT_EXPIRED_STATUS = "vencido_falta_comprobante"

const EXPIRABLE_PAYMENT_STATUSES = new Set([
  "pendiente_comprobante",
  "pending",
])

/**
 * Tope defensivo para expireOverdueTransferOrders: sin esto, la consulta que
 * busca pedidos de transferencia vencidos no tenía `.limit()` ni acotaba
 * columnas (`select("*")`), a diferencia de su equivalente de Mercado Pago
 * (expireAbandonedMercadoPagoOrders, que sí limita a 50 filas). Esta función
 * corre en cada tick del cron cada 15 minutos Y en cada carga del panel
 * admin de pedidos (GET /api/admin/pedidos) -- un payload sin cota, con
 * columnas jsonb pesadas de más, es un riesgo real de latencia/timeout a
 * medida que se acumulan pedidos vencidos sin comprobante.
 */
const MAX_OVERDUE_TRANSFER_ORDERS_PER_RUN = 50

/** Únicas columnas que consumen isTransferOrderExpiredWithoutProof/expireTransferOrderIfNeeded. */
const TRANSFER_EXPIRATION_LOAD_SELECT =
  "id, created_at, estado, payment_method_id, payment_status, payment_proof_url, payment_proof_uploaded_at, financial_status, credit_balance_used, store_benefit_id"

type TransferExpirationCandidate = Pick<
  SupabasePedido,
  | "id"
  | "created_at"
  | "estado"
  | "payment_method_id"
  | "payment_status"
  | "payment_proof_url"
  | "payment_proof_uploaded_at"
  | "financial_status"
> &
  Partial<Pick<SupabasePedido, "credit_balance_used" | "store_benefit_id">>

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

export async function expireTransferOrderIfNeeded<
  T extends TransferExpirationCandidate = SupabasePedido,
>(admin: AdminClient, order: T, now = new Date()) {
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

  // Sólo quien ganó el UPDATE condicional llega acá: el pedido nunca recibió
  // un pago, así que el saldo y el beneficio aplicados no pueden quedar
  // retenidos en un pedido cancelado (mismo criterio que la expiración de
  // Mercado Pago). reverse_customer_credit_for_order es idempotente y el
  // beneficio sólo se reactiva si sigue ligado a ESTE pedido.
  const cancelled = updatedOrder as SupabasePedido
  try {
    if (Number(cancelled.credit_balance_used ?? 0) > 0) {
      await reverseCustomerCreditForOrder(admin, {
        orderId: order.id,
        description: "Reintegro de saldo: el pedido por transferencia venció sin pago",
      })
    }
    if (cancelled.store_benefit_id) {
      await restoreStoreBenefitFromSupersededOrder(admin, {
        benefitId: cancelled.store_benefit_id,
        orderId: order.id,
      })
    }
  } catch (releaseError) {
    console.error("TRANSFER_EXPIRATION_CREDIT_OR_BENEFIT_RELEASE_ERROR", {
      orderId: order.id,
      message: releaseError instanceof Error ? releaseError.message : String(releaseError),
    })
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
    .select(TRANSFER_EXPIRATION_LOAD_SELECT)
    .eq("payment_method_id", "transferencia")
    .in("payment_status", Array.from(EXPIRABLE_PAYMENT_STATUSES))
    .is("payment_proof_url", null)
    .is("payment_proof_uploaded_at", null)
    .neq("estado", "cancelado")
    .lte("created_at", cutoff)
    .order("created_at", { ascending: true })
    .limit(MAX_OVERDUE_TRANSFER_ORDERS_PER_RUN)

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

  for (const order of (orders ?? []) as TransferExpirationCandidate[]) {
    const updatedOrder = await expireTransferOrderIfNeeded(admin, order)
    if (updatedOrder.estado === "cancelado" && order.estado !== "cancelado") {
      expiredCount += 1
    }
  }

  return expiredCount
}
