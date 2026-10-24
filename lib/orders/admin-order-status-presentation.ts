/**
 * Presentación de estados del admin de pedidos (sólo lectura, sin reglas de
 * negocio nuevas):
 * - DESPACHO = estado logístico/envío. Nunca muestra el estado general del
 *   pedido ("Cancelado" vive en la columna ESTADO).
 * - RESUMEN = estado ejecutivo del pedido con un tono que se distingue de un
 *   vistazo (rojo cancelado/crítico, verde entregado/cobrado, ámbar
 *   pendiente o incidencia leve, azul en curso, neutro terminal).
 */

import { ORDER_CANCELLATION_REFUND_LABELS } from "./order-cancellation-refund-state.ts"
import {
  getDispatchProgress,
  getShippingStage,
  SHIPPING_STAGE_LABELS,
  type ShippingStage,
  type ShippingStageOrder,
} from "./shipping-stage.ts"

export type AdminOrderStatusTone = "danger" | "success" | "warning" | "info" | "neutral"

export interface AdminOrderStatusPresentation {
  label: string
  tone: AdminOrderStatusTone
}

export type AdminDispatchStatusKey =
  | "not_shipped"
  | "preparing"
  | "ready"
  | "handed_over"
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
  /** BEYONIX entregó el paquete al transportista (QR final del Bulto). */
  andreani_handed_over_at?: string | null
  andreani_envio_id?: string | null
  andreani_creation_status?: string | null
  /** Pickeo en Despachos (admin_pending_facts del listado). */
  admin_pending_facts?: { dispatch?: { packageStatus?: "preparing" | "prepared" | null } | null } | null
}

const DISPATCH_BY_ESTADO: Partial<Record<string, AdminDispatchStatus>> = {
  // Entrega final al cliente: nunca se confunde con la entrega a Andreani (Despachado).
  entregado: { key: "delivered", label: SHIPPING_STAGE_LABELS.delivered, tone: "success" },
  devuelto_beyonix: { key: "returned", label: "Devuelto a BEYONIX", tone: "neutral" },
  en_devolucion: { key: "returning", label: "En devolución", tone: "warning" },
  visita_fallida: { key: "delivery_incident", label: "Visita fallida", tone: "warning" },
  retiro_vencido: { key: "delivery_incident", label: "Retiro vencido", tone: "warning" },
  en_sucursal: { key: "awaiting_pickup", label: "En sucursal", tone: "info" },
  retiro_pendiente: { key: "awaiting_pickup", label: "Retiro pendiente", tone: "info" },
  en_camino: { key: "in_transit", label: SHIPPING_STAGE_LABELS.in_transit, tone: "info" },
  // Admisión de Andreani sin movimiento de transporte: sigue siendo Despachado.
  enviado: { key: "shipped", label: SHIPPING_STAGE_LABELS.dispatched, tone: "info" },
  preparado: { key: "ready", label: SHIPPING_STAGE_LABELS.ready, tone: "info" },
}

/** QR final del Bulto (BEYONIX -> Andreani); después manda el estado del transporte. */
const HANDED_OVER: AdminDispatchStatus = { key: "handed_over", label: SHIPPING_STAGE_LABELS.dispatched, tone: "info" }
const PREPARING: AdminDispatchStatus = { key: "preparing", label: SHIPPING_STAGE_LABELS.preparing, tone: "info" }
const READY = DISPATCH_BY_ESTADO.preparado as AdminDispatchStatus

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
  // QR final: Despachado (nunca "Entregado" ni "En camino" por sí solo), aunque se cancele después.
  if (order.andreani_handed_over_at && (!byEstado || byEstado.key === "ready")) return HANDED_OVER
  if (byEstado) return byEstado

  if (order.estado !== "cancelado") {
    const progress = getDispatchProgress(null, order.admin_pending_facts?.dispatch?.packageStatus)
    // El envío Andreani se genera al terminar el pickeo: ya está listo para despachar.
    if (
      progress === "ready" ||
      String(order.andreani_envio_id ?? "").trim() ||
      ANDREANI_SHIPMENT_IN_PROGRESS.has(order.andreani_creation_status ?? "")
    ) return READY
    if (progress === "preparing") return PREPARING
  }

  return {
    key: "not_shipped",
    label: "No enviado",
    tone: awaitingDispatch && order.estado !== "cancelado" ? "warning" : "neutral",
  }
}

/**
 * Etapa visible del envío en Admin (timeline del detalle): misma regla que el
 * cliente; un envío Andreani ya generado sin armado registrado cuenta como listo.
 */
export function getAdminShippingStage(
  order: AdminDispatchOrder & ShippingStageOrder,
  paymentConfirmed: boolean,
): ShippingStage | null {
  const shipmentGenerated = Boolean(String(order.andreani_envio_id ?? "").trim()) ||
    ANDREANI_SHIPMENT_IN_PROGRESS.has(order.andreani_creation_status ?? "")
  const dispatchProgress = getDispatchProgress(order.andreani_handed_over_at, order.admin_pending_facts?.dispatch?.packageStatus) ??
    (shipmentGenerated ? "ready" : null)
  return getShippingStage(order, { paymentConfirmed, dispatchProgress })
}

export type AdminExecutiveStatusKey =
  | "cancelled_refunded"
  | "cancelled_refunded_credit_note_pending"
  | "cancelled_refund_pending"
  | "refunded"
  | "refund_pending"
  | "cancelled_refund_rejected"
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
  cancelled_refunded: { label: ORDER_CANCELLATION_REFUND_LABELS.refunded.admin, tone: "danger" },
  // Caso heredado: el dinero volvió pero falta la NC que anula la factura.
  cancelled_refunded_credit_note_pending: { label: "Reintegro realizado · Nota de crédito pendiente", tone: "warning" },
  cancelled_refund_pending: { label: ORDER_CANCELLATION_REFUND_LABELS.refund_in_progress.admin, tone: "danger" },
  cancelled_refund_rejected: { label: ORDER_CANCELLATION_REFUND_LABELS.refund_rejected.admin, tone: "warning" },
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
  preparado: { label: SHIPPING_STAGE_LABELS.ready, tone: "info" },
  enviado: { label: SHIPPING_STAGE_LABELS.dispatched, tone: "info" },
  en_camino: { label: SHIPPING_STAGE_LABELS.in_transit, tone: "info" },
  en_sucursal: { label: "En sucursal", tone: "info" },
  retiro_pendiente: { label: "Retiro pendiente", tone: "info" },
  visita_fallida: { label: "Visita fallida", tone: "warning" },
  retiro_vencido: { label: "Retiro vencido", tone: "warning" },
  en_devolucion: { label: "En devolución", tone: "warning" },
  devuelto_beyonix: { label: "Devuelto a BEYONIX", tone: "neutral" },
  entregado: { label: SHIPPING_STAGE_LABELS.delivered, tone: "success" },
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
