import "server-only"

import { reverseCustomerCreditForOrder } from "../customer-credit/server.ts"
import { findMercadoPagoPaymentByExternalReference } from "../mercadopago/customer-credit-topups.ts"
import { MERCADOPAGO_ABANDONED_ORDER_GRACE_HOURS } from "../mercadopago/checkout-attempt.ts"
import { appendOrderAuditEvent } from "./order-audit.ts"
import type { createAdminClient } from "../supabase/admin.ts"

type AdminClient = ReturnType<typeof createAdminClient>

interface ExpirableMercadoPagoOrder {
  id: number
  estado: string
  payment_status?: string | null
  financial_status?: string | null
  credit_balance_used?: number | null
  mercadopago_preference_expires_at?: string | null
}

const SAFE_TO_EXPIRE_PAYMENT_STATUSES = new Set([
  "cancelled",
  "rejected",
])

export function getMercadoPagoAbandonedOrderCutoff(now = new Date()) {
  return new Date(
    now.getTime() -
      MERCADOPAGO_ABANDONED_ORDER_GRACE_HOURS * 60 * 60 * 1000,
  )
}

export async function expireAbandonedMercadoPagoOrders(
  admin: AdminClient,
  now = new Date(),
) {
  const cutoff = getMercadoPagoAbandonedOrderCutoff(now).toISOString()
  const { data, error } = await admin
    .from("ordenes")
    .select(
      "id, estado, payment_status, financial_status, credit_balance_used, mercadopago_preference_expires_at",
    )
    .eq("payment_method_id", "mercadopago")
    .eq("estado", "pendiente")
    .eq("financial_status", "pending_payment")
    .lte("mercadopago_preference_expires_at", cutoff)
    .order("mercadopago_preference_expires_at", { ascending: true })
    .limit(50)

  if (error) {
    throw new Error(
      error.message || "No se pudieron buscar órdenes abandonadas.",
    )
  }

  let expired = 0

  for (const order of (data ?? []) as ExpirableMercadoPagoOrder[]) {
    let payment

    try {
      payment = await findMercadoPagoPaymentByExternalReference(
        String(order.id),
      )
    } catch (reconciliationError) {
      console.warn("MERCADOPAGO_ABANDONED_ORDER_RECONCILIATION_ERROR", {
        orderId: order.id,
        error: reconciliationError,
      })
      continue
    }

    if (payment && !SAFE_TO_EXPIRE_PAYMENT_STATUSES.has(payment.status)) {
      continue
    }

    const expiredAt = now.toISOString()
    const previousStatus =
      order.financial_status ?? order.payment_status ?? "pending_payment"
    const { data: updatedOrder, error: updateError } = await admin
      .from("ordenes")
      .update({
        estado: "cancelado",
        payment_status: "checkout_expired",
        financial_status: "cancelled",
        cancelled_at: expiredAt,
        mercadopago_init_point: null,
        mercadopago_preference_claim_token: null,
        mercadopago_preference_claimed_at: null,
      } as never)
      .eq("id", order.id)
      .eq("estado", "pendiente")
      .eq("financial_status", "pending_payment")
      .lte("mercadopago_preference_expires_at", cutoff)
      .select("id")
      .maybeSingle()

    if (updateError) throw updateError
    if (!updatedOrder) continue

    if (Number(order.credit_balance_used ?? 0) > 0) {
      await reverseCustomerCreditForOrder(admin, {
        orderId: order.id,
        description: "Reintegro de saldo por checkout de Mercado Pago vencido",
      })
    }

    await appendOrderAuditEvent(admin, {
      orderId: order.id,
      actorType: "system",
      action: "mercadopago_checkout_auto_expired",
      previousStatus,
      newStatus: "cancelled",
      metadata: {
        reason: "checkout_abandoned",
        expiredAt,
        preferenceExpiredAt:
          order.mercadopago_preference_expires_at ?? null,
      },
    })
    expired += 1
  }

  return expired
}
