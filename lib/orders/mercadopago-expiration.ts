import "server-only"

import { reverseCustomerCreditForOrder } from "../customer-credit/server.ts"
import { findMercadoPagoPaymentForOrder } from "../mercadopago/customer-credit-topups.ts"
import { MERCADOPAGO_ABANDONED_ORDER_GRACE_HOURS } from "../mercadopago/checkout-attempt.ts"
import { appendOrderAuditEvent } from "./order-audit.ts"
import type { createAdminClient } from "../supabase/admin.ts"

type AdminClient = ReturnType<typeof createAdminClient>

interface ExpirableMercadoPagoOrder {
  id: number
  created_at?: string | null
  mercadopago_checkout_fingerprint?: string | null
  mercadopago_reference?: string | null
  mercadopago_reference_assigned_at?: string | null
  estado: string
  payment_status?: string | null
  financial_status?: string | null
  credit_balance_used?: number | null
  mercadopago_preference_expires_at?: string | null
  andreani_creation_status?: string | null
  andreani_envio_id?: string | null
}

const SAFE_TO_EXPIRE_PAYMENT_STATUSES = new Set([
  "cancelled",
  "rejected",
])

// Auditoría Andreani Parte 4/4 (hardening final): en operación normal, un
// pedido nunca llega a andreani_creation_status='claimed'/
// 'reconciliation_required'/'created' mientras financial_status sigue en
// 'pending_payment' -- claim_andreani_shipment_creation exige evidencia de
// pago confirmado (ver supabase/migrations/20260917100000_...). Esta función
// dependía únicamente de esa invariante indirecta para no cruzarse con un
// envío Andreani en curso. Acá se agrega la MISMA garantía de forma
// explícita y local, sin depender de que esa invariante se mantenga para
// siempre en código futuro que toque pagos MP.
const ANDREANI_ORDER_IN_PROGRESS_STATUSES = new Set([
  "claimed",
  "reconciliation_required",
  "created",
])

function isAndreaniShipmentInProgressOrCreated(order: ExpirableMercadoPagoOrder) {
  return (
    ANDREANI_ORDER_IN_PROGRESS_STATUSES.has(order.andreani_creation_status ?? "") ||
    Boolean((order.andreani_envio_id ?? "").toString().trim())
  )
}

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
      "id, created_at, estado, payment_status, financial_status, credit_balance_used, mercadopago_preference_expires_at, mercadopago_checkout_fingerprint, mercadopago_reference, mercadopago_reference_assigned_at, andreani_creation_status, andreani_envio_id",
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
    if (isAndreaniShipmentInProgressOrCreated(order)) continue

    let payment

    try {
      // Sólo pagos de ESTA orden: un pago aprobado de una orden vieja con el
      // mismo número (ids reutilizados) no puede frenar la expiración.
      payment = await findMercadoPagoPaymentForOrder(order)
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
      // Re-chequeo atómico: si entre el SELECT y este UPDATE alguien reclamó
      // la creación del envío (claim_andreani_shipment_creation), esta
      // condición ya no matchea y el UPDATE no afecta ninguna fila -- nunca
      // se cancela un pedido con Andreani en curso o resuelto.
      .or("andreani_creation_status.is.null,andreani_creation_status.eq.failed,andreani_creation_status.eq.rejected")
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
