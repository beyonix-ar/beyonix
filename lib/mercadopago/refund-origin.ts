/**
 * ¿Qué reintegros de un pago de Mercado Pago hizo BEYONIX y cuáles no?
 *
 * No alcanza con mirar payment.status: un reintegro PARCIAL deja el pago en
 * "approved". Se comparan conjuntos:
 *
 *   REFUNDS QUE INFORMA MERCADO PAGO  vs  REFUNDS QUE BEYONIX REGISTRÓ
 *
 * Todo refund que MP conoce y BEYONIX no, es externo (hecho a mano en el
 * panel de MP o por otra vía) y se alerta POR SU IMPORTE, nunca por el total.
 *
 * Sin falsos positivos por respuesta perdida: un intento propio todavía en
 * curso (processing/needs_reconciliation, sin id de MP guardado) reclama el
 * refund informado de su mismo importe.
 */

export interface MercadoPagoReportedRefund {
  id?: unknown
  amount?: unknown
  status?: unknown
}

export interface MercadoPagoRefundedPayment {
  refunds?: MercadoPagoReportedRefund[] | null
  transaction_amount_refunded?: number | null
}

export interface BeyonixConfirmedRefund {
  mp_refund_id: string | null
  amount: number | string
}

export interface BeyonixRefundAttempt {
  status: string
  mp_refund_id: string | null
  amount: number | string
}

export interface UnknownMercadoPagoRefund {
  /** Clave estable para no alertar dos veces el mismo dinero. */
  key: string
  /** Id del refund en MP; null si MP sólo informó el total reintegrado. */
  mpRefundId: string | null
  amount: number
}

/** Refunds que MP rechazó o anuló no movieron dinero. */
const VOID_REFUND_STATUSES = new Set(["rejected", "cancelled"])
const OWN_ATTEMPT_STATUSES = new Set(["confirmed", "processing", "needs_reconciliation"])

export function moneyCents(value: unknown) {
  const amount = Number(value)
  return Number.isFinite(amount) ? Math.round(amount * 100) : 0
}

function refundId(value: unknown) {
  return value == null ? "" : String(value).trim()
}

export function getUnknownMercadoPagoRefunds(
  paymentId: string | number,
  payment: MercadoPagoRefundedPayment,
  ownAttempts: BeyonixRefundAttempt[],
  /** Importe ya alertado antes como excedente sin detalle (no se alerta dos veces). */
  alertedWithoutDetail = 0,
): UnknownMercadoPagoRefund[] {
  const seen = new Set<string>()
  const reported = (Array.isArray(payment.refunds) ? payment.refunds : [])
    .filter((refund) => !VOID_REFUND_STATUSES.has(String(refund.status ?? "").toLowerCase()))
    .map((refund) => ({ id: refundId(refund.id), cents: moneyCents(refund.amount) }))
    // Sin id ni importe no hay nada que comparar; un id sin importe igual se compara.
    .filter((refund) => (refund.id || refund.cents > 0) && (!refund.id || !seen.has(refund.id)) && (refund.id ? seen.add(refund.id) : true))

  const own = ownAttempts.filter((attempt) => OWN_ATTEMPT_STATUSES.has(attempt.status))
  const ownIds = new Set(own.map((attempt) => refundId(attempt.mp_refund_id)).filter(Boolean))
  // Intentos propios sin id de MP (respuesta perdida): reclaman por importe.
  const unidentified = own.filter((attempt) => !refundId(attempt.mp_refund_id)).map((attempt) => moneyCents(attempt.amount))

  const unknown: UnknownMercadoPagoRefund[] = []
  for (const refund of reported) {
    if (refund.id && ownIds.has(refund.id)) continue
    const claimed = unidentified.indexOf(refund.cents)
    if (claimed >= 0) {
      unidentified.splice(claimed, 1)
      continue
    }
    unknown.push({
      key: refund.id ? `mp_refund:${refund.id}` : `mp_refund_amount:${paymentId}:${refund.cents}`,
      mpRefundId: refund.id || null,
      amount: refund.cents / 100,
    })
  }

  // MP informa más dinero devuelto que el detalle de refunds (o no trae
  // detalle): el excedente sobre lo identificado y lo propio es desconocido.
  const reportedCents = reported.reduce((sum, refund) => sum + refund.cents, 0)
  const ownCents = own.reduce((sum, attempt) => sum + moneyCents(attempt.amount), 0)
  const totalCents = moneyCents(payment.transaction_amount_refunded)
  const explained = Math.max(reportedCents, ownCents + unknown.reduce((sum, refund) => sum + moneyCents(refund.amount), 0)) +
    moneyCents(alertedWithoutDetail)
  if (totalCents > explained) {
    unknown.push({
      key: `mp_refund_total:${paymentId}:${totalCents}`,
      mpRefundId: null,
      amount: (totalCents - explained) / 100,
    })
  }
  return unknown
}

/** Compatibilidad: ¿hay algún reintegro que BEYONIX no registró? */
export function classifyMercadoPagoRefundOrigin(
  payment: MercadoPagoRefundedPayment,
  confirmedRefunds: BeyonixConfirmedRefund[],
): "beyonix" | "external" {
  const attempts = confirmedRefunds.map((refund) => ({ ...refund, status: "confirmed" }))
  if (!attempts.length) return moneyCents(payment.transaction_amount_refunded) > 0 || (payment.refunds ?? []).length ? "external" : "beyonix"
  return getUnknownMercadoPagoRefunds("payment", payment, attempts).length ? "external" : "beyonix"
}

/** ¿El pago trae alguna señal de dinero devuelto? */
export function hasMercadoPagoRefundSignal(payment: MercadoPagoRefundedPayment) {
  return moneyCents(payment.transaction_amount_refunded) > 0 ||
    (Array.isArray(payment.refunds) && payment.refunds.some((refund) => moneyCents(refund.amount) > 0))
}
