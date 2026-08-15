import type { MercadoPagoPayment } from "./customer-credit-topups.ts"

export interface MercadoPagoOrderPaymentRow {
  estado: string
  total?: number | null
  external_amount_due?: number | null
  financial_status?: string | null
}

export type MercadoPagoOrderPaymentResult =
  | { kind: "confirmed"; confirmedAmount: number }
  | { kind: "duplicate" }
  | {
      kind: "amount_mismatch"
      expectedAmount: number
      receivedAmount: number | null
    }
  | { kind: "currency_mismatch"; receivedCurrency: string | null }

type ConfirmPayment = (confirmedAmount: number) => Promise<boolean>

const PAID_ORDER_STATUSES = new Set([
  "pagado",
  "preparado",
  "enviado",
  "en_camino",
  "visita_fallida",
  "en_sucursal",
  "retiro_pendiente",
  "retiro_vencido",
  "en_devolucion",
  "devuelto_beyonix",
  "entregado",
  "approved",
])
const CONFIRMED_FINANCIAL_STATUSES = new Set([
  "payment_confirmed",
  "cancellation_requested",
  "refund_pending",
  "refunded",
])

function moneyToCents(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null
  }

  const cents = Math.round(value * 100)
  if (
    !Number.isSafeInteger(cents) ||
    Math.abs(value * 100 - cents) > 0.000001
  ) {
    return null
  }

  return cents
}

export function isMercadoPagoOrderAlreadyConfirmed(
  order: MercadoPagoOrderPaymentRow,
) {
  return (
    PAID_ORDER_STATUSES.has(order.estado) ||
    CONFIRMED_FINANCIAL_STATUSES.has(order.financial_status ?? "")
  )
}

export async function processApprovedMercadoPagoOrderPayment(
  order: MercadoPagoOrderPaymentRow,
  payment: Pick<
    MercadoPagoPayment,
    "status" | "transaction_amount" | "currency_id"
  >,
  confirmPayment: ConfirmPayment,
): Promise<MercadoPagoOrderPaymentResult> {
  if (isMercadoPagoOrderAlreadyConfirmed(order)) {
    return { kind: "duplicate" }
  }

  if (payment.status !== "approved") {
    throw new Error("El pago no está aprobado.")
  }

  if (payment.currency_id !== "ARS") {
    return {
      kind: "currency_mismatch",
      receivedCurrency: payment.currency_id ?? null,
    }
  }

  const expectedAmount = Number(
    order.external_amount_due ?? order.total ?? Number.NaN,
  )
  const expectedCents = moneyToCents(expectedAmount)
  const receivedCents = moneyToCents(payment.transaction_amount)

  if (
    expectedCents === null ||
    expectedCents <= 0 ||
    receivedCents === null ||
    receivedCents !== expectedCents
  ) {
    return {
      kind: "amount_mismatch",
      expectedAmount:
        expectedCents === null ? expectedAmount : expectedCents / 100,
      receivedAmount:
        receivedCents === null ? null : receivedCents / 100,
    }
  }

  const confirmedAmount = receivedCents / 100
  const confirmed = await confirmPayment(confirmedAmount)

  return confirmed
    ? { kind: "confirmed", confirmedAmount }
    : { kind: "duplicate" }
}
