import "server-only"

import type { createAdminClient } from "@/lib/supabase/admin"

import {
  getMercadoPagoPayment,
  type MercadoPagoPayment,
} from "./customer-credit-topups.ts"
import { moneyToCents } from "./order-payment.ts"
import {
  createMercadoPagoRefund,
  getMercadoPagoRefundStatus,
  type MercadoPagoRefundOutcome,
} from "./refunds.ts"

type AdminClient = ReturnType<typeof createAdminClient>

interface BeginRefundRow {
  refund_id: string
  payment_id: string
  amount: number
  idempotency_key: string
  status: string
  should_call_mp: boolean
  mp_refund_id: string | null
}

export type MercadoPagoOrderRefundResult =
  | { kind: "confirmed"; mpRefundId: string; amount: number }
  | { kind: "already_confirmed" }
  | { kind: "in_progress"; status: "processing" | "needs_reconciliation" }
  | { kind: "rejected"; code: string | null; message: string }
  | { kind: "unknown"; reason: string }
  | { kind: "validation_failed"; reason: string }

export type MercadoPagoOrderReconciliationResult =
  | { kind: "confirmed"; mpRefundId: string; amount: number }
  | { kind: "not_found_yet" }
  | { kind: "unknown"; reason: string }
  | { kind: "nothing_to_reconcile" }

interface RefundDependencies {
  getPayment?: (paymentId: string) => Promise<MercadoPagoPayment>
  createRefund?: (
    paymentId: string,
    idempotencyKey: string,
  ) => Promise<MercadoPagoRefundOutcome>
  getRefundStatus?: (
    paymentId: string,
    refundId: string | null,
  ) => ReturnType<typeof getMercadoPagoRefundStatus>
}

/**
 * Valida server-side, contra el pago REAL reconsultado a Mercado Pago (nunca
 * contra columnas locales sin verificar), que este payment puede refundearse
 * exactamente por `expectedAmount` para esta orden. Fail-closed: cualquier
 * discrepancia devuelve un motivo y NO se procede.
 */
function validateRefundablePayment(
  payment: MercadoPagoPayment,
  params: { orderId: number; expectedPaymentId: string; expectedAmount: number },
): string | null {
  if (String(payment.id) !== params.expectedPaymentId) {
    return "PAYMENT_ID_MISMATCH"
  }
  if (payment.external_reference !== String(params.orderId)) {
    return "EXTERNAL_REFERENCE_MISMATCH"
  }
  if (payment.status !== "approved") {
    return "PAYMENT_STATUS_NOT_REFUNDABLE"
  }
  if (payment.currency_id !== "ARS") {
    return "CURRENCY_MISMATCH"
  }

  const expectedCents = moneyToCents(params.expectedAmount)
  const paidCents = moneyToCents(payment.transaction_amount)
  if (expectedCents === null || paidCents === null || expectedCents !== paidCents) {
    return "AMOUNT_MISMATCH"
  }

  const refundedCents = moneyToCents(payment.transaction_amount_refunded ?? 0) ?? 0
  if (refundedCents >= paidCents) {
    return "PAYMENT_ALREADY_FULLY_REFUNDED"
  }
  if (refundedCents > 0) {
    // Fase 1 sólo soporta refund total: un refund parcial previo (por
    // cualquier vía) deja el caso fuera de este flujo automático.
    return "PARTIAL_REFUND_ALREADY_EXISTS"
  }

  return null
}

function sanitizeErrorForLog(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Orquesta un refund total contra Mercado Pago para un pedido ya aprobado
 * para reembolso (financial_status='refund_pending', ver
 * approve_order_claim_cancellation). El monto SIEMPRE es el que
 * begin_mercadopago_order_refund calcula a partir de
 * ordenes.payment_confirmed_amount -- el componente realmente capturado por
 * MP, nunca ordenes.total (en un pedido con customer_credit + MP, el saldo ya
 * se reintegra por separado vía reverse_customer_credit_for_order).
 */
export async function refundMercadoPagoOrderPayment(
  admin: AdminClient,
  params: { orderId: number; adminId: string },
  deps: RefundDependencies = {},
): Promise<MercadoPagoOrderRefundResult> {
  const getPayment = deps.getPayment ?? getMercadoPagoPayment
  const createRefund = deps.createRefund ?? createMercadoPagoRefund

  const { data: beginData, error: beginError } = await admin.rpc(
    "begin_mercadopago_order_refund",
    { p_order_id: params.orderId, p_admin_id: params.adminId },
  )
  if (beginError) {
    return { kind: "validation_failed", reason: beginError.message }
  }
  const attempt = (Array.isArray(beginData) ? beginData[0] : beginData) as
    | BeginRefundRow
    | undefined
  if (!attempt) {
    return { kind: "validation_failed", reason: "EMPTY_BEGIN_RESULT" }
  }

  if (!attempt.should_call_mp) {
    if (attempt.status === "confirmed") return { kind: "already_confirmed" }
    return {
      kind: "in_progress",
      status: attempt.status as "processing" | "needs_reconciliation",
    }
  }

  let payment: MercadoPagoPayment
  try {
    payment = await getPayment(attempt.payment_id)
  } catch (error) {
    await admin.rpc("record_mercadopago_order_refund_result", {
      p_refund_id: attempt.refund_id,
      p_outcome: "needs_reconciliation",
      p_error_code: "PAYMENT_LOOKUP_FAILED",
      p_error_message: sanitizeErrorForLog(error),
    })
    return { kind: "unknown", reason: "PAYMENT_LOOKUP_FAILED" }
  }

  const validationError = validateRefundablePayment(payment, {
    orderId: params.orderId,
    expectedPaymentId: attempt.payment_id,
    expectedAmount: attempt.amount,
  })
  if (validationError) {
    await admin.rpc("record_mercadopago_order_refund_result", {
      p_refund_id: attempt.refund_id,
      p_outcome: "failed",
      p_error_code: validationError,
      p_error_message: "Validación previa al refund falló; no se llegó a contactar el refund de Mercado Pago.",
    })
    return { kind: "validation_failed", reason: validationError }
  }

  const outcome = await createRefund(attempt.payment_id, attempt.idempotency_key)

  if (outcome.kind === "confirmed") {
    await admin.rpc("record_mercadopago_order_refund_result", {
      p_refund_id: attempt.refund_id,
      p_outcome: "confirmed",
      p_mp_refund_id: String(outcome.refund.id),
    })
    return {
      kind: "confirmed",
      mpRefundId: String(outcome.refund.id),
      amount: attempt.amount,
    }
  }

  if (outcome.kind === "rejected") {
    await admin.rpc("record_mercadopago_order_refund_result", {
      p_refund_id: attempt.refund_id,
      p_outcome: "failed",
      p_error_code: outcome.code,
      p_error_message: outcome.message,
    })
    return { kind: "rejected", code: outcome.code, message: outcome.message }
  }

  // outcome.kind === "unknown": timeout, 5xx o respuesta ilegible. El POST
  // pudo o no haber llegado a procesarse en Mercado Pago -- NUNCA se asume
  // ninguna de las dos cosas. Queda en needs_reconciliation.
  await admin.rpc("record_mercadopago_order_refund_result", {
    p_refund_id: attempt.refund_id,
    p_outcome: "needs_reconciliation",
    p_error_code: "MP_RESPONSE_UNKNOWN",
    p_error_message: outcome.reason,
  })
  return { kind: "unknown", reason: outcome.reason }
}

/**
 * Núcleo de la reconciliación, compartido entre reconcileMercadoPagoOrderRefund
 * (búsqueda por pedido, un solo intento) y el job por lote
 * (lib/mercadopago/reconciliation-batch.ts, que ya trae la fila reservada vía
 * claim_mercadopago_refunds_for_reconciliation). SIEMPRE reconsulta a
 * Mercado Pago por GET -- nunca dispara un POST de refund.
 */
export async function reconcileRefundAttempt(
  admin: AdminClient,
  refundRow: { id: string; payment_id: string; mp_refund_id: string | null },
  deps: RefundDependencies = {},
): Promise<MercadoPagoOrderReconciliationResult> {
  const getRefundStatus = deps.getRefundStatus ?? getMercadoPagoRefundStatus
  const remoteStatus = await getRefundStatus(refundRow.payment_id, refundRow.mp_refund_id)

  if (remoteStatus.kind === "found") {
    await admin.rpc("reconcile_mercadopago_order_refund", {
      p_refund_id: refundRow.id,
      p_outcome: "confirmed",
      p_mp_refund_id: String(remoteStatus.refund.id),
    })
    return {
      kind: "confirmed",
      mpRefundId: String(remoteStatus.refund.id),
      amount: remoteStatus.refund.amount,
    }
  }

  if (remoteStatus.kind === "not_found") {
    // Mercado Pago no tiene ningún refund registrado para este payment: el
    // POST original nunca se procesó. Seguro reintentarlo -- vuelve a
    // 'requested' con la MISMA idempotency_key, nunca una nueva.
    await admin.rpc("reconcile_mercadopago_order_refund", {
      p_refund_id: refundRow.id,
      p_outcome: "requested",
    })
    return { kind: "not_found_yet" }
  }

  // Sigue siendo ambiguo (timeout/5xx al reconciliar): se deja tal cual
  // (needs_reconciliation) para un próximo intento de reconciliación. Nunca
  // se marca 'failed' por esto -- sólo un rechazo autoritativo de Mercado
  // Pago (POST 'rejected') es un fallo definitivo.
  await admin.rpc("reconcile_mercadopago_order_refund", {
    p_refund_id: refundRow.id,
    p_outcome: "needs_reconciliation",
    p_error_code: "RECONCILIATION_INCONCLUSIVE",
    p_error_message: remoteStatus.reason,
  })
  return { kind: "unknown", reason: remoteStatus.reason }
}

/**
 * Reconcilia el intento 'processing'/'needs_reconciliation' más reciente de
 * UN pedido puntual (uso admin/webhook). Para el job por lote, ver
 * lib/mercadopago/reconciliation-batch.ts.
 */
export async function reconcileMercadoPagoOrderRefund(
  admin: AdminClient,
  params: { orderId: number },
  deps: RefundDependencies = {},
): Promise<MercadoPagoOrderReconciliationResult> {
  const { data: pending, error: pendingError } = await admin
    .from("mercadopago_order_refunds")
    .select("id, payment_id, mp_refund_id, status")
    .eq("order_id", params.orderId)
    .in("status", ["processing", "needs_reconciliation"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (pendingError) {
    return { kind: "unknown", reason: pendingError.message }
  }
  if (!pending) {
    return { kind: "nothing_to_reconcile" }
  }

  return reconcileRefundAttempt(admin, pending, deps)
}
