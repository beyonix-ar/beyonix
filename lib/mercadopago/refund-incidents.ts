import "server-only"

import type { createAdminClient } from "@/lib/supabase/admin"

import { reconcileMercadoPagoOrderRefund } from "./order-refund.ts"
import {
  getUnknownMercadoPagoRefunds,
  moneyCents,
  type BeyonixRefundAttempt,
  type MercadoPagoRefundedPayment,
  type UnknownMercadoPagoRefund,
} from "./refund-origin.ts"

type AdminClient = ReturnType<typeof createAdminClient>

export interface MercadoPagoRefundAuditPayment extends MercadoPagoRefundedPayment {
  id: number | string
  transaction_amount?: number | null
}

const PENDING_ATTEMPT_STATUSES = ["processing", "needs_reconciliation"]

async function loadAttempts(admin: AdminClient, orderId: number, paymentId: string) {
  const { data, error } = await admin
    .from("mercadopago_order_refunds")
    .select("status, mp_refund_id, amount")
    .eq("order_id", orderId)
    .eq("payment_id", paymentId)
  if (error) throw new Error(`MERCADOPAGO_REFUND_ATTEMPTS_LOOKUP_FAILED: ${error.message}`)
  return (data ?? []) as BeyonixRefundAttempt[]
}

async function loadAlertedWithoutDetail(admin: AdminClient, orderId: number, paymentId: string) {
  const { data, error } = await admin
    .from("order_audit_events")
    .select("metadata")
    .eq("order_id", orderId)
    .eq("action", "mp_external_refund_detected")
    .like("metadata->>incidentKey", `mp_refund_total:${paymentId}:%`)
  if (error) throw new Error(`MERCADOPAGO_REFUND_INCIDENTS_LOOKUP_FAILED: ${error.message}`)
  return (data ?? []).reduce((sum, row) => sum + Number((row.metadata as { amount?: unknown } | null)?.amount ?? 0), 0)
}

/**
 * Compara los refunds que informa Mercado Pago para un pago con los que
 * BEYONIX registró y alerta cada refund desconocido una sola vez (por su
 * importe). Nunca crea ni completa operaciones: sólo audita.
 *
 * Si un intento propio sigue en curso, primero se concilia (GET, nunca
 * POST): una respuesta perdida no puede terminar alertada como externa.
 * Si no se puede leer el estado local, lanza: el webhook responde error y
 * Mercado Pago reintenta, en vez de alertar a ciegas un falso positivo.
 */
export async function auditMercadoPagoRefundsForOrder(
  admin: AdminClient,
  params: { orderId: number; payment: MercadoPagoRefundAuditPayment },
  deps: { reconcile?: typeof reconcileMercadoPagoOrderRefund } = {},
): Promise<{ unknown: UnknownMercadoPagoRefund[]; recorded: number }> {
  const { orderId, payment } = params
  const paymentId = String(payment.id)
  let attempts = await loadAttempts(admin, orderId, paymentId)
  if (attempts.some((attempt) => PENDING_ATTEMPT_STATUSES.includes(attempt.status))) {
    await (deps.reconcile ?? reconcileMercadoPagoOrderRefund)(admin, { orderId })
    attempts = await loadAttempts(admin, orderId, paymentId)
  }

  const unknown = getUnknownMercadoPagoRefunds(paymentId, payment, attempts,
    await loadAlertedWithoutDetail(admin, orderId, paymentId))
  const paidCents = moneyCents(payment.transaction_amount)
  let recorded = 0
  for (const refund of unknown) {
    const { data, error } = await admin.rpc("record_mercadopago_payment_incident", {
      p_order_id: orderId,
      p_action: "mp_external_refund_detected",
      p_incident_key: refund.key,
      p_metadata: {
        paymentId,
        mpRefundId: refund.mpRefundId,
        amount: refund.amount,
        partial: paidCents > 0 && moneyCents(refund.amount) < paidCents,
        reason: "refund_not_registered_by_beyonix",
      },
    })
    if (error) throw new Error(`MERCADOPAGO_REFUND_INCIDENT_PERSIST_FAILED: ${error.message}`)
    if (data === true) recorded += 1
  }
  return { unknown, recorded }
}

/** Contracargo: una sola alerta por pago, aunque el webhook se repita. */
export async function recordMercadoPagoChargebackIncident(admin: AdminClient, orderId: number, paymentId: string) {
  const { error } = await admin.rpc("record_mercadopago_payment_incident", {
    p_order_id: orderId,
    p_action: "mp_chargeback_detected",
    p_incident_key: `mp_chargeback:${paymentId}`,
    p_metadata: { paymentId, reason: "chargeback_requires_manual_resolution" },
  })
  if (error) throw new Error(`MERCADOPAGO_CHARGEBACK_INCIDENT_PERSIST_FAILED: ${error.message}`)
}
