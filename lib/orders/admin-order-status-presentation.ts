/**
 * Presentación de estados del admin de pedidos (sólo lectura, sin reglas de
 * negocio nuevas):
 * - DESPACHO = estado logístico/envío. Nunca muestra el estado general del
 *   pedido ("Cancelado" vive en la columna ESTADO).
 * - RESUMEN = estado ejecutivo del pedido con un tono que se distingue de un
 *   vistazo (rojo cancelado/crítico, verde entregado/cobrado, ámbar
 *   pendiente o incidencia leve, azul en curso, neutro terminal).
 */

export type AdminOrderStatusTone = "danger" | "success" | "warning" | "info" | "neutral"

export interface AdminOrderStatusPresentation {
  label: string
  tone: AdminOrderStatusTone
}

export type AdminDispatchStatusKey =
  | "not_shipped"
  | "preparing"
  | "shipped"
  | "in_transit"
  | "delivery_incident"
  | "awaiting_pickup"
  | "returning"
  | "returned"
  | "delivered"

export interface AdminDispatchStatus extends AdminOrderStatusPresentation {
  key: AdminDispatchStatusKey
}

export interface AdminDispatchOrder {
  estado: string
  delivered_at?: string | null
  andreani_envio_id?: string | null
  andreani_creation_status?: string | null
}

const DISPATCH_BY_ESTADO: Partial<Record<string, AdminDispatchStatus>> = {
  entregado: { key: "delivered", label: "Entregado", tone: "success" },
  devuelto_beyonix: { key: "returned", label: "Devuelto a BEYONIX", tone: "neutral" },
  en_devolucion: { key: "returning", label: "En devolución", tone: "warning" },
  visita_fallida: { key: "delivery_incident", label: "Visita fallida", tone: "warning" },
  retiro_vencido: { key: "delivery_incident", label: "Retiro vencido", tone: "warning" },
  en_sucursal: { key: "awaiting_pickup", label: "En sucursal", tone: "info" },
  retiro_pendiente: { key: "awaiting_pickup", label: "Retiro pendiente", tone: "info" },
  en_camino: { key: "in_transit", label: "En camino", tone: "info" },
  enviado: { key: "shipped", label: "Enviado", tone: "info" },
  preparado: { key: "preparing", label: "En preparación", tone: "info" },
}

const ANDREANI_SHIPMENT_IN_PROGRESS = new Set(["claimed", "created", "reconciliation_required"])

/**
 * Columna DESPACHO: sólo el estado logístico. Un pedido cancelado antes de
 * salir figura "No enviado" (la cancelación ya se ve en ESTADO); los
 * pedidos no se pueden cancelar una vez despachados, así que la cancelación
 * nunca oculta un envío real. `awaitingDispatch` (pago confirmado y todavía
 * sin despachar) sólo sube el tono a ámbar para marcar la acción pendiente.
 */
export function getAdminDispatchStatus(
  order: AdminDispatchOrder,
  { awaitingDispatch = false }: { awaitingDispatch?: boolean } = {},
): AdminDispatchStatus {
  if (order.estado === "entregado" || order.delivered_at) {
    return DISPATCH_BY_ESTADO.entregado as AdminDispatchStatus
  }

  const byEstado = DISPATCH_BY_ESTADO[order.estado]
  if (byEstado) return byEstado

  if (
    order.estado !== "cancelado" &&
    (String(order.andreani_envio_id ?? "").trim() ||
      ANDREANI_SHIPMENT_IN_PROGRESS.has(order.andreani_creation_status ?? ""))
  ) {
    return DISPATCH_BY_ESTADO.preparado as AdminDispatchStatus
  }

  return {
    key: "not_shipped",
    label: "No enviado",
    tone: awaitingDispatch && order.estado !== "cancelado" ? "warning" : "neutral",
  }
}

export type AdminExecutiveStatusKey =
  | "cancelled_refunded"
  | "cancelled_refund_pending"
  | "refunded"
  | "refund_pending"
  | "cancellation_requested"
  | "help_message"
  | "claim_open"
  | "payment_rejected"
  | "credit_note_missing"
  | "invoice_pending"
  | "shipping_pending"
  | "payment_confirmed"

/** Estados ejecutivos que no salen del `estado` crudo del pedido. */
export const ADMIN_EXECUTIVE_STATUS: Record<AdminExecutiveStatusKey, AdminOrderStatusPresentation> = {
  cancelled_refunded: { label: "Cancelado · Reintegrado", tone: "danger" },
  cancelled_refund_pending: { label: "Cancelado · Reintegro pendiente", tone: "danger" },
  refunded: { label: "Reintegrado", tone: "neutral" },
  refund_pending: { label: "Reintegro pendiente", tone: "danger" },
  cancellation_requested: { label: "Cancelación solicitada", tone: "danger" },
  help_message: { label: "Mensaje de ayuda", tone: "warning" },
  claim_open: { label: "Reclamo abierto", tone: "danger" },
  payment_rejected: { label: "Pago rechazado", tone: "danger" },
  credit_note_missing: { label: "Falta nota de crédito", tone: "warning" },
  invoice_pending: { label: "Factura pendiente", tone: "warning" },
  shipping_pending: { label: "Envío pendiente", tone: "warning" },
  payment_confirmed: { label: "Pago confirmado", tone: "success" },
}

const EXECUTIVE_STATUS_BY_ESTADO: Partial<Record<string, AdminOrderStatusPresentation>> = {
  cancelado: { label: "Cancelado", tone: "danger" },
  rechazado: { label: "Pago rechazado", tone: "danger" },
  refund_pending: ADMIN_EXECUTIVE_STATUS.refund_pending,
  refunded: ADMIN_EXECUTIVE_STATUS.refunded,
  pendiente: { label: "Pendiente de pago", tone: "warning" },
  pagado: ADMIN_EXECUTIVE_STATUS.payment_confirmed,
  approved: ADMIN_EXECUTIVE_STATUS.payment_confirmed,
  preparado: { label: "En preparación", tone: "info" },
  enviado: { label: "Enviado", tone: "info" },
  en_camino: { label: "En camino", tone: "info" },
  en_sucursal: { label: "En sucursal", tone: "info" },
  retiro_pendiente: { label: "Retiro pendiente", tone: "info" },
  visita_fallida: { label: "Visita fallida", tone: "warning" },
  retiro_vencido: { label: "Retiro vencido", tone: "warning" },
  en_devolucion: { label: "En devolución", tone: "warning" },
  devuelto_beyonix: { label: "Devuelto a BEYONIX", tone: "neutral" },
  entregado: { label: "Entregado", tone: "success" },
}

/**
 * Estado ejecutivo a partir del estado mostrado del pedido
 * (`getDisplayedOrderStatus` del admin). Un valor desconocido nunca se
 * muestra crudo con guiones bajos.
 */
export function getAdminExecutiveStatusFromEstado(estado: string): AdminOrderStatusPresentation {
  const known = EXECUTIVE_STATUS_BY_ESTADO[estado]
  if (known) return known

  const label = estado.replace(/_/g, " ").trim()
  return {
    label: label ? label.charAt(0).toLocaleUpperCase("es-AR") + label.slice(1) : "Sin estado",
    tone: "neutral",
  }
}
