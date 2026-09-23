export interface AdminOrderVisibilityRow {
  id: number
  created_at?: string | null
  admin_visible_at?: string | null
  payment_method_id?: string | null
  payment_status?: string | null
  payment_confirmed_at?: string | null
}

const REJECTED_PAYMENT_STATUSES = new Set(["rechazado", "rejected"])

export function isAdminOrderVisible(order: AdminOrderVisibilityRow) {
  return (
    Number.isFinite(order.id) &&
    typeof order.admin_visible_at === "string" &&
    order.admin_visible_at.length > 0
  )
}

/**
 * Momento en que el pago de una transferencia quedó REALMENTE confirmado, o
 * null mientras no lo esté. `payment_confirmed_at` lo fijan únicamente los
 * dos caminos que confirman una transferencia -- la verificación automática
 * (`confirm_transfer_auto_verification`) y la revisión manual del admin
 * (`review_manual_transfer_payment`) -- y la revisión manual lo vuelve a null
 * al rechazar. Orden creada, comprobante en revisión, verificación con
 * conflicto de stock o comprobante rechazado: nunca tienen esta fecha.
 */
export function getTransferPaymentConfirmedAt(order: AdminOrderVisibilityRow) {
  if (order.payment_method_id !== "transferencia") return null
  if (REJECTED_PAYMENT_STATUSES.has(order.payment_status ?? "")) return null

  const confirmedAt = order.payment_confirmed_at
  return typeof confirmedAt === "string" && confirmedAt.length > 0
    ? confirmedAt
    : null
}

/**
 * Fecha del evento administrativo "Pedido nuevo": el pedido ya está
 * confirmado y entra al circuito operativo.
 *
 * - Mercado Pago: `admin_visible_at`, que el trigger
 *   `set_order_admin_visibility` sólo completa con el pago aprobado.
 * - Transferencia: la orden es visible en el Admin desde que se crea (hay
 *   que poder revisar su comprobante), pero el pedido recién es "nuevo"
 *   cuando el pago se confirma (`getTransferPaymentConfirmedAt`).
 * - Resto de medios (p. ej. saldo a favor, que se confirma al crearse):
 *   `admin_visible_at`.
 *
 * La fecha es fija una vez confirmada y la clave es una por pedido
 * (`getAdminNewOrderEventKey`), así que reprocesar una verificación o
 * refrescar el Admin nunca genera una segunda notificación.
 */
export function getAdminNewOrderEventAt(order: AdminOrderVisibilityRow) {
  if (!isAdminOrderVisible(order)) return null

  if (order.payment_method_id === "transferencia") {
    return getTransferPaymentConfirmedAt(order)
  }

  return order.admin_visible_at!
}

export function getAdminNewOrderEventKey(orderId: number) {
  return `order:${orderId}`
}
