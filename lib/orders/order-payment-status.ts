export interface OrderPaymentConfirmationRow {
  payment_status?: string | null
  paid_at?: string | null
  payment_confirmed_amount?: number | null
  financial_status?: string | null
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
