/**
 * ¿Un pago que Mercado Pago informa como "refunded" fue reintegrado por
 * BEYONIX o por fuera (a mano desde el panel de Mercado Pago)?
 *
 * El webhook llega casi siempre DESPUÉS de que nuestro POST de refund ya se
 * confirmó, así que no alcanza con buscar intentos "en curso": hay que
 * comparar los refunds que informa MP contra los que BEYONIX registró.
 */

export interface MercadoPagoRefundedPayment {
  refunds?: Array<{ id?: unknown; amount?: unknown }> | null
  transaction_amount_refunded?: number | null
}

export interface BeyonixConfirmedRefund {
  mp_refund_id: string | null
  amount: number | string
}

function cents(value: unknown) {
  const amount = Number(value)
  return Number.isFinite(amount) ? Math.round(amount * 100) : 0
}

export function classifyMercadoPagoRefundOrigin(
  payment: MercadoPagoRefundedPayment,
  confirmedRefunds: BeyonixConfirmedRefund[],
): "beyonix" | "external" {
  if (!confirmedRefunds.length) return "external"

  const ownRefundIds = new Set(
    confirmedRefunds
      .map((refund) => (refund.mp_refund_id == null ? "" : String(refund.mp_refund_id).trim()))
      .filter(Boolean),
  )
  const reportedRefunds = Array.isArray(payment.refunds) ? payment.refunds : []
  if (reportedRefunds.length) {
    // Un solo refund que BEYONIX no registró ya es dinero que salió por fuera.
    return reportedRefunds.every((refund) => ownRefundIds.has(String(refund.id ?? "").trim()))
      ? "beyonix"
      : "external"
  }

  // Sin detalle de refunds: externo sólo si MP devolvió más de lo que BEYONIX confirmó.
  const ownCents = confirmedRefunds.reduce((total, refund) => total + cents(refund.amount), 0)
  return cents(payment.transaction_amount_refunded) <= ownCents ? "beyonix" : "external"
}
