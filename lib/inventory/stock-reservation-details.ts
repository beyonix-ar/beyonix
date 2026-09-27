/**
 * Detalle de lo que compone "Reservado" en Admin (Fase 5). Sólo datos
 * operativos: cantidad, destino (variante/stock con descuento), vencimiento,
 * pedido vinculado y estado. Nunca sesión, usuario ni datos del cliente.
 */

export type StockReservationDetailStatus =
  | "checkout"
  | "order_pending"
  | "payment_in_process"

export interface StockReservationDetailRow {
  variant_id: number | null
  conditioned_stock_id: string | null
  quantity: number
  expires_at: string
  order_id: number | null
}

export interface StockReservationDetail {
  variantId: number | null
  conditionedStockId: string | null
  quantity: number
  /** null = retenida sin vencimiento mientras Mercado Pago procesa el pago. */
  expiresAt: string | null
  orderId: number | null
  status: StockReservationDetailStatus
}

export const STOCK_RESERVATION_STATUS_LABEL: Record<StockReservationDetailStatus, string> = {
  checkout: "En checkout (Paso 3)",
  order_pending: "Pedido pendiente de pago",
  payment_in_process: "Pago en proceso",
}

function isUnboundedExpiry(value: string) {
  return /^infinity$/i.test(value.trim()) || !Number.isFinite(Date.parse(value))
}

export function describeStockReservation(row: StockReservationDetailRow): StockReservationDetail {
  const unbounded = isUnboundedExpiry(String(row.expires_at))
  const orderId = row.order_id == null ? null : Number(row.order_id)
  return {
    variantId: row.variant_id == null ? null : Number(row.variant_id),
    conditionedStockId: row.conditioned_stock_id == null ? null : String(row.conditioned_stock_id),
    quantity: Math.max(0, Math.trunc(Number(row.quantity) || 0)),
    expiresAt: unbounded ? null : new Date(row.expires_at).toISOString(),
    orderId,
    status: orderId == null
      ? "checkout"
      : unbounded
        ? "payment_in_process"
        : "order_pending",
  }
}
