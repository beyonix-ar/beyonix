export interface OrderPaymentConfirmationRow {
  payment_status?: string | null
  paid_at?: string | null
  payment_confirmed_amount?: number | null
  financial_status?: string | null
}

/** `payment_status` que escriben las confirmaciones reales (MP: approved). */
export const CONFIRMED_PAYMENT_STATUSES = ["confirmado", "approved", "confirmed"]

/**
 * Evidencia financiera REAL de un pago confirmado, para operaciones que no
 * pueden apoyarse sólo en `financial_status` (que por sí solo no prueba un
 * cobro). Las cuatro vías que confirman un pago escriben juntos estos campos:
 * - webhook de Mercado Pago (payment_status=approved);
 * - transferencia revisada a mano (review_manual_transfer_payment) o
 *   verificada automáticamente (payment_status=confirmado);
 * - saldo a favor (customer-credit/create-order, payment_status=confirmado);
 * - combinaciones saldo + MP/transferencia: las confirma la vía externa.
 * Exige los cuatro: `financial_status = payment_confirmed`, `paid_at`,
 * `payment_confirmed_amount > 0` y `payment_status` confirmado. Un pago
 * revertido (rechazado, approved_*_mismatch, conflicto de stock, etc.) nunca
 * tiene `payment_status` confirmado, y refund_pending/refunded/cancelled no son
 * `payment_confirmed`.
 */
export function hasConfirmedPaymentEvidence(order: OrderPaymentConfirmationRow) {
  return (
    order.financial_status === "payment_confirmed" &&
    Boolean(order.paid_at) &&
    Number(order.payment_confirmed_amount ?? 0) > 0 &&
    CONFIRMED_PAYMENT_STATUSES.includes(order.payment_status ?? "")
  )
}

export function isOrderPaymentConfirmed(order: OrderPaymentConfirmationRow) {
  return (
    Boolean(order.paid_at) ||
    Number(order.payment_confirmed_amount ?? 0) > 0 ||
    ["confirmado", "approved", "confirmed"].includes(
      order.payment_status ?? "",
    ) ||
    [
      "payment_confirmed",
      "refund_pending",
      "refunded",
    ].includes(order.financial_status ?? "")
  )
}
