const DISPATCHED_OR_LATER_STATUSES = [
  "pagado",
  "enviado",
  "en_camino",
  "visita_fallida",
  "en_sucursal",
  "retiro_pendiente",
  "retiro_vencido",
  "en_devolucion",
  "devuelto_beyonix",
  "entregado",
]

export interface OrderPaymentConfirmationRow {
  payment_status?: string | null
  paid_at?: string | null
  estado?: string | null
}

export function isOrderPaymentConfirmed(order: OrderPaymentConfirmationRow) {
  return (
    Boolean(order.paid_at) ||
    ["confirmado", "approved", "confirmed"].includes(
      order.payment_status ?? "",
    ) ||
    DISPATCHED_OR_LATER_STATUSES.includes(order.estado ?? "")
  )
}
