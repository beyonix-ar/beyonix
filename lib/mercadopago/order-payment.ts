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

/**
 * Estado que queda en la orden cuando Mercado Pago aprobó el pago pero el
 * inventario ya no permite confirmarla (la reserva venció y otra compra se
 * quedó con las unidades). El dinero es real: la orden NO se confirma sola ni
 * se cancela sola, queda marcada para resolución manual.
 */
export const MERCADOPAGO_STOCK_CONFLICT_PAYMENT_STATUS =
  "approved_stock_conflict"

/**
 * Un pago aprobado que el guardián de inventario
 * (`validate_inventory_order_confirmation`) rechaza. Se distingue de
 * cualquier otro error de base para no reintentar eternamente algo que no se
 * arregla reintentando.
 */
export class MercadoPagoInventoryConflictError extends Error {
  readonly conflict: unknown

  constructor(conflict?: unknown) {
    super("El inventario ya no permite confirmar esta orden pagada.")
    this.name = "MercadoPagoInventoryConflictError"
    this.conflict = conflict
  }
}

export function isInventoryConfirmationConflict(error: unknown) {
  const message =
    error instanceof Error
      ? error.message
      : error && typeof error === "object" && "message" in error
        ? String((error as { message: unknown }).message ?? "")
        : ""

  return /checkout_stock_insufficient|checkout_variant_required/i.test(message)
}

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
