/**
 * Reglas de visibilidad de pedidos para Cliente y Admin (única fuente).
 *
 * Cliente — "Mis compras" muestra su historial real:
 * - pedidos pendientes de pago/transferencia (puede pagar o subir comprobante),
 * - pagados, en curso, entregados, cancelados y reintegrados,
 * - cualquier pedido con rastro de dinero o fiscal (pago, factura, NC,
 *   reintegro, saldo, comprobante, reclamo, envío).
 * Se ocultan sólo:
 * - intentos de checkout de Mercado Pago cancelados sin ningún rastro (pago
 *   nunca aprobado, reemplazado por otro intento o abandonado): el Admin
 *   tampoco los ve (admin_visible_at nunca se completó),
 * - pedidos archivados explícitamente como prueba con "ocultar al cliente"
 *   (customer_hidden_at), que sólo puede marcar un super_admin.
 * Nunca se infiere "prueba" por monto, email ni fecha.
 *
 * Admin — listado operativo: admin_visible_at (pago aprobado o transferencia
 * creada) y no archivado. Archivados: filtro aparte; siguen en búsqueda por
 * id y en la auditoría. Las alertas (campana) no filtran archivados: un
 * incidente nuevo sobre un pedido archivado se ve igual.
 */

export interface OrderTraceRow {
  id?: number
  total?: number | string | null
  estado?: string | null
  payment_method_id?: string | null
  payment_status?: string | null
  financial_status?: string | null
  admin_visible_at?: string | null
  paid_at?: string | null
  payment_confirmed_at?: string | null
  payment_confirmed_amount?: number | string | null
  payment_proof_uploaded_at?: string | null
  invoice_status?: string | null
  invoice_cae?: string | null
  refund_pending_at?: string | null
  refunded_at?: string | null
  credit_balance_used?: number | string | null
  credit_note_cae?: string | null
  tracking_number?: string | null
  andreani_envio_id?: string | null
  order_claims?: unknown[] | null
  customer_hidden_at?: string | null
}

/** Estados de pago que implican dinero recibido (aunque luego se haya devuelto). */
const MONEY_PAYMENT_STATUSES = new Set([
  "approved",
  "confirmado",
  "confirmed",
  "refunded",
  "charged_back",
  "in_mediation",
  "approved_amount_mismatch",
  "approved_currency_mismatch",
  "approved_stock_conflict",
  "approved_after_cancellation",
  "auto_verified_stock_conflict",
])

export function orderHasMoneyOrFiscalTrace(order: OrderTraceRow): boolean {
  return Boolean(
    order.paid_at ||
      order.payment_confirmed_at ||
      Number(order.payment_confirmed_amount ?? 0) > 0 ||
      MONEY_PAYMENT_STATUSES.has(order.payment_status ?? "") ||
      order.payment_proof_uploaded_at ||
      order.invoice_cae ||
      ["authorized", "processing"].includes(order.invoice_status ?? "") ||
      order.refund_pending_at ||
      order.refunded_at ||
      ["refund_pending", "refunded"].includes(order.financial_status ?? "") ||
      Number(order.credit_balance_used ?? 0) > 0 ||
      order.credit_note_cae ||
      order.tracking_number ||
      order.andreani_envio_id ||
      (order.order_claims?.length ?? 0) > 0,
  )
}

/**
 * Intento de checkout de Mercado Pago que nunca llegó a ser compra: cancelado,
 * nunca visible para el Admin y sin ningún rastro de dinero/fiscal.
 */
export function isAbandonedCheckoutAttempt(order: OrderTraceRow): boolean {
  return (
    order.estado === "cancelado" &&
    order.payment_method_id === "mercadopago" &&
    !order.admin_visible_at &&
    !orderHasMoneyOrFiscalTrace(order)
  )
}

export function isCustomerOrderVisible(order: OrderTraceRow): boolean {
  if (order.customer_hidden_at) return false
  return !isAbandonedCheckoutAttempt(order)
}

export type AdminArchiveFilter = "active" | "archived" | "all"

export function parseAdminArchiveFilter(value: string | null | undefined): AdminArchiveFilter | null {
  if (value == null || value === "" || value === "active") return "active"
  if (value === "archived" || value === "all") return value
  return null
}

export function isOrderArchived(order: { archived_at?: string | null }) {
  return Boolean(order.archived_at)
}

/** Códigos de order_archive_blockers / order_delete_blockers en lenguaje humano. */
export const ORDER_ARCHIVE_BLOCKER_LABELS: Record<string, string> = {
  not_found: "El pedido no existe.",
  already_archived: "El pedido ya está archivado.",
  active_order: "El pedido sigue activo (pendiente, pagado o en curso).",
  financial_in_progress: "Hay una cancelación o un reintegro en curso.",
  invoice_in_progress: "La factura está pendiente, en proceso o con error.",
  credit_note_processing: "Hay una nota de crédito comunicándose con ARCA.",
  credit_note_pending: "Falta la nota de crédito obligatoria de la factura.",
  refund_in_progress: "Hay un reintegro de Mercado Pago sin confirmar.",
  open_payment_incident: "Hay un incidente de pago abierto.",
  open_claim: "Hay un reclamo abierto.",
  shipment_in_progress: "Hay un envío creado sin entregar.",
  payment: "Tiene un pago registrado.",
  invoice: "Tiene factura emitida.",
  credit_note: "Tiene notas de crédito.",
  refund: "Tiene reintegros registrados.",
  customer_credit: "Movió saldo a favor del cliente.",
  shipment: "Tiene un envío creado.",
  claim: "Tiene reclamos.",
}

export function describeOrderBlockers(codes: readonly string[]) {
  return codes.map((code) => ORDER_ARCHIVE_BLOCKER_LABELS[code] ?? code)
}
