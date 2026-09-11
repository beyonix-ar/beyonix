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

/** Compartida con el refund de MP (lib/mercadopago/order-refund.ts): la comparación de montos siempre debe hacerse en centavos, nunca en floats. */
export function moneyToCents(value: number | null | undefined) {
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

/**
 * P1: una orden cancelada ANTES de confirmarse (expiración de checkout,
 * cancelación del cliente o de admin) queda con estado='cancelado' y
 * financial_status='cancelled' -- ninguno de los dos está en
 * PAID_ORDER_STATUSES/CONFIRMED_FINANCIAL_STATUSES, así que
 * isMercadoPagoOrderAlreadyConfirmed() da false y un payment aprobado tardío
 * (reintento con otra tarjeta sobre la misma preferencia, latencia normal del
 * webhook, etc.) seguía el camino normal de confirmación y "resucitaba" la
 * orden a pagado. 'cancelado' es el único valor de estado que usan de forma
 * consistente la expiración de checkout (lib/orders/mercadopago-expiration.ts)
 * y las RPC de cancelación de cliente/admin -- por eso alcanza como único
 * discriminante, sin depender de financial_status (que sí varía: 'cancelled'
 * si nunca se pagó, 'refund_pending'/'refunded' si ya estaba pagada, pero esos
 * dos últimos ya están cubiertos por isMercadoPagoOrderAlreadyConfirmed).
 */
export function isMercadoPagoOrderCancelled(order: MercadoPagoOrderPaymentRow) {
  return order.estado === "cancelado"
}

/**
 * payment_status que deja una orden cancelada cuando Mercado Pago aprueba un
 * pago después de la cancelación. El dinero es real y queda auditado
 * (order_audit_events), pero la orden NO se reactiva: requiere reconciliación
 * manual, igual que MERCADOPAGO_STOCK_CONFLICT_PAYMENT_STATUS.
 */
export const MERCADOPAGO_APPROVED_AFTER_CANCELLATION_STATUS =
  "approved_after_cancellation"

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
