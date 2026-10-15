/**
 * Lógica pura de notificaciones del admin: tipo/forma de una notificación,
 * construcción de las de cancelación/claim, y las reglas de dedupe/
 * prioridad que deciden cuál queda visible por pedido.
 *
 * Vive separada de lib/admin/admin-notifications.ts (que sí importa el
 * cliente de Supabase y hace fetch de datos) exclusivamente para poder
 * testear esta lógica con `node --test` sin necesitar resolución de alias
 * "@/" ni mocks de Supabase -- sólo importa módulos relativos, sin efectos
 * secundarios. admin-notifications.ts importa todo lo de acá y re-exporta
 * los tipos que ya consumían otros archivos del admin.
 */

import { ADMIN_ROUTES } from "./admin-routes.ts"
import { claimNeedsAdminAttention } from "../orders/claim-attention.ts"

export { claimNeedsAdminAttention }
import { isClaimVisibleForMode } from "../orders/claim-visibility.ts"
import {
  getAdminPendingOrderActions,
  type AdminPendingActionsOrder,
  type AdminPendingOrderAction,
  type AdminPendingOrderActionKind,
} from "../orders/admin-pending-actions.ts"
import {
  getOpenPaymentIncidents,
  PAYMENT_INCIDENT_LABELS,
  type PaymentIncidentAction,
} from "../orders/payment-incidents.ts"

export type AdminNotificationType =
  | "order"
  | "message"
  | "payment"
  | "invoice"
  | "shipping"
  | "cancellation"
  | "claim"
  | "mercadolibre_return"
  | "inventory"

export interface AdminNotification {
  id: string
  type: AdminNotificationType
  eventKey: string
  eventAt: string
  title: string
  body: string
  actionLabel?: string
  actionUrl: string
  orderId?: number
  isRead: boolean
  priority?: "attention"
  /**
   * action: requiere intervención humana y suma al contador rojo.
   * info: evento para leer (pedido nuevo, mensaje); nunca suma al contador.
   */
  kind?: "action" | "info"
  /**
   * true cuando una acción financiera de cancelación lleva pendiente más del
   * umbral esperado para su estado (ver STALE_THRESHOLD_MS_BY_STATE). Sólo
   * afecta el ORDEN en que se muestra (keepLatestNotificationByOrder empuja
   * lo vencido arriba, ver sortByEventDate) -- nunca dispara ninguna acción
   * ni mueve dinero por sí sola.
   */
  stale?: boolean
}

function getTime(value?: string | null) {
  if (!value) return 0
  const time = new Date(value).getTime()
  return Number.isFinite(time) ? time : 0
}

export function formatOrderId(orderId: number) {
  return `#BX-${1000 + orderId}`
}


export interface CancellationNotificationOrder extends AdminPendingActionsOrder {
  id: number
  created_at?: string | null
  cancelled_at?: string | null
  cancellation_requested_at?: string | null
  refund_pending_at?: string | null
  paid_at?: string | null
  invoice_created_at?: string | null
}

/** Acciones de dinero de una cancelación (misma fuente que el contador del pedido). */
const CANCELLATION_ACTION_COPY: Partial<Record<AdminPendingOrderActionKind, string>> = {
  cancellation_request: "El cliente pidió cancelar la compra.",
  refund: "Elegí cómo devolver el dinero.",
  refund_manual: "Registrá el reintegro realizado por fuera del sistema.",
  refund_retry: "BEYONIX no pudo completar una actualización interna.",
  advanced_case: "El reintegro necesita la gestión completa.",
}

/**
 * Umbral a partir del cual una acción pendiente se marca `stale` (ver
 * AdminNotification.stale): un reintento pendiente se vuelve crítico mucho
 * antes que el resto.
 */
const STALE_THRESHOLD_MS_BY_KIND: Partial<Record<AdminPendingOrderActionKind, number>> = {
  refund_retry: 6 * 60 * 60 * 1000,
  advanced_case: 24 * 60 * 60 * 1000,
  refund: 48 * 60 * 60 * 1000,
  refund_manual: 48 * 60 * 60 * 1000,
}

function actionNotification(
  order: CancellationNotificationOrder,
  action: AdminPendingOrderAction,
  type: AdminNotificationType,
  eventAt: string,
  body: string,
  now: number,
): AdminNotification {
  const eventKey = type === "cancellation" ? `cancellation:${action.kind}:${order.id}` : `${type}:${order.id}`
  const threshold = STALE_THRESHOLD_MS_BY_KIND[action.kind]
  return {
    id: eventKey,
    type,
    eventKey,
    eventAt,
    title: action.label,
    body: `${formatOrderId(order.id)} — ${body}`,
    actionLabel: action.label,
    actionUrl: action.href,
    orderId: order.id,
    isRead: false,
    priority: action.urgent ? "attention" : undefined,
    stale: Boolean(threshold && now - getTime(eventAt) > threshold),
    kind: "action",
  }
}

/**
 * Tarea de dinero de una cancelación, derivada de getAdminPendingOrderActions
 * (única fuente del contador). `null` cuando no hay intervención humana: sin
 * pago confirmado, ya resuelto, o un paso automático (NC en ARCA, reintegro
 * en proceso) -- así la alerta desaparece sola al resolverse.
 */
export function buildCancellationNotification(
  order: CancellationNotificationOrder,
  now: number = Date.now(),
): AdminNotification | null {
  const cancelledAt =
    order.refund_pending_at || order.cancellation_requested_at || order.cancelled_at
  if (!cancelledAt) return null
  const action = getAdminPendingOrderActions(order).find((item) => CANCELLATION_ACTION_COPY[item.kind])
  if (!action) return null
  return actionNotification(order, action, "cancellation", String(cancelledAt), CANCELLATION_ACTION_COPY[action.kind]!, now)
}

/**
 * Tareas humanas del flujo normal (factura que la cola automática no cubre,
 * preparar o entregar el despacho). La facturación en cola y los reintentos
 * automáticos no generan tarea.
 */
export function buildOrderWorkNotifications(
  order: CancellationNotificationOrder,
  now: number = Date.now(),
): AdminNotification[] {
  const notifications: AdminNotification[] = []
  for (const action of getAdminPendingOrderActions(order)) {
    if (action.kind === "invoice") {
      notifications.push(actionNotification(order, action, "invoice", String(order.paid_at || order.created_at),
        "La factura no se emite automáticamente.", now))
    } else if (action.kind === "dispatch_prepare" || action.kind === "shipping") {
      notifications.push(actionNotification(order, action, "shipping",
        String(order.invoice_created_at || order.paid_at || order.created_at),
        "Pedido facturado y listo para preparar.", now))
    }
  }
  return notifications
}

/** Acciones del pedido que no son cancelación/factura/envío y requieren a una persona. */
const ORDER_ALERT_COPY: Partial<Record<AdminPendingOrderActionKind, { type: AdminNotificationType; body: string }>> = {
  legacy_credit_note: { type: "invoice", body: "La factura sigue sin su nota de crédito obligatoria." },
  payment_conflict: { type: "payment", body: "Pago cobrado que no se pudo confirmar: revisalo o reintegralo." },
  dispatch_blocked: { type: "shipping", body: "Pedido cancelado que sigue dentro de una tanda de despacho." },
  return: { type: "claim", body: "Devolución pendiente de revisión." },
}

/**
 * Alertas que requieren acción y no tienen builder propio. Una por tipo de
 * acción y pedido (eventKey estable): refrescar o releer no las duplica, y
 * desaparecen solas cuando la acción deja de existir.
 */
export function buildOrderAlertNotifications(
  order: CancellationNotificationOrder,
  now: number = Date.now(),
): AdminNotification[] {
  const notifications: AdminNotification[] = []
  for (const action of getAdminPendingOrderActions(order)) {
    const copy = ORDER_ALERT_COPY[action.kind]
    if (!copy) continue
    const eventAt = String(order.refund_pending_at || order.cancelled_at || order.paid_at || order.created_at)
    const notification = actionNotification(order, action, copy.type, eventAt, action.label === "Revisar nota de crédito"
      ? "Las notas de crédito autorizadas no cubren la factura: requiere revisión manual."
      : copy.body, now)
    const eventKey = `${action.kind}:${order.id}`
    notifications.push({ ...notification, id: eventKey, eventKey })
  }
  return notifications
}

/**
 * Un incidente de pago abierto (reintegro externo / contracargo) = una alerta.
 * El eventKey es el del evento de auditoría; si por datos históricos hay dos
 * eventos iguales (mismo tipo y mismo pago) se muestra uno solo. Al marcarlo
 * falso positivo o resuelto deja de estar abierto y la alerta desaparece; el
 * evento queda en el historial del pedido.
 */
export function buildPaymentIncidentNotifications(order: CancellationNotificationOrder): AdminNotification[] {
  const seen = new Set<string>()
  const notifications: AdminNotification[] = []
  for (const incident of getOpenPaymentIncidents(order.order_audit_events)) {
    const paymentId = incident.metadata?.paymentId
    const dedupeKey = `${incident.action}:${paymentId == null ? `event:${incident.id}` : String(paymentId)}`
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    const eventKey = `payment_incident:${incident.id}`
    const label = PAYMENT_INCIDENT_LABELS[incident.action as PaymentIncidentAction]
    notifications.push({
      id: eventKey,
      type: "payment",
      eventKey,
      eventAt: String(incident.created_at || order.created_at),
      title: label,
      body: `${formatOrderId(order.id)} — ${incident.action === "mp_chargeback_detected"
        ? "El cliente desconoció el pago: revisá el contracargo."
        : "Mercado Pago informa un reintegro que BEYONIX no registró."}`,
      actionLabel: "Revisar",
      actionUrl: `${ADMIN_ROUTES.pedidos}/${order.id}?tab=pago`,
      orderId: order.id,
      isRead: false,
      priority: "attention",
      kind: "action",
    })
  }
  return notifications
}

export interface ClaimAttentionInput {
  id: number
  order_id: number
  failure_type?: string | null
  admin_needs_action?: boolean | null
  first_reviewed_at?: string | null
  last_customer_message_at?: string | null
  last_admin_response_at?: string | null
  status?: string | null
  created_at?: string | null
}

/**
 * `null` cuando el claim no necesita una notificación tipo "claim": ya
 * resuelto, o `cancelar_compra` (tiene su propio flujo, ver
 * buildCancellationNotification -- generar acá una notificación hacia
 * ?tab=reclamos para esos casos era exactamente el bug reportado: competía
 * por prioridad con la notificación de cancelación real y la tapaba,
 * mandando al admin a "Atención al cliente" en vez de a la gestión
 * concreta).
 */
export function buildClaimNotification(
  claim: ClaimAttentionInput,
): AdminNotification | null {
  if (!claimNeedsAdminAttention(claim)) return null
  if (!isClaimVisibleForMode(claim.failure_type, "all")) return null

  const orderId = Number(claim.order_id)
  const helpMessage = claim.failure_type === "consulta_pedido"

  return {
    id: `claim:${claim.id}`,
    type: "claim",
    eventKey: `claim:${claim.id}`,
    eventAt: String(claim.last_customer_message_at || claim.created_at),
    title: helpMessage ? "Mensaje de ayuda por responder" : "Reclamo por responder",
    body: helpMessage
      ? `El mensaje de ayuda del pedido ${formatOrderId(orderId)} requiere atención.`
      : `El reclamo del pedido ${formatOrderId(orderId)} requiere atención.`,
    actionLabel: helpMessage ? "Responder mensaje" : "Resolver reclamo",
    actionUrl: `${ADMIN_ROUTES.pedidos}/${orderId}?tab=reclamos`,
    orderId,
    isRead: false,
    kind: "action",
  }
}

/** Acción vs información: sólo lo primero suma al contador rojo. */
export function isAdminActionNotification(notification: Pick<AdminNotification, "kind" | "type">) {
  return notification.kind ? notification.kind === "action" : !["order", "message"].includes(notification.type)
}

export function dedupeNotifications(notifications: AdminNotification[]) {
  const seen = new Set<string>()
  return notifications.filter((notification) => {
    const key =
      notification.type === "claim" && notification.orderId
        ? `${notification.type}:${notification.eventKey}:${notification.orderId}`
        : `${notification.type}:${notification.eventKey}`

    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function getOperationalPriority(notification: AdminNotification) {
  // Una cancelación con una acción financiera concreta pendiente (emitir
  // NC, registrar reintegro, revisar un refund de Mercado Pago) nunca debe
  // quedar tapada por un claim genérico -- ver
  // lib/orders/cancellation-next-action.ts. Con el fix de arriba (que ya
  // excluye cancelar_compra de generar notificaciones tipo "claim"), esto
  // sólo importa para el caso de dos eventos con el MISMO eventAt exacto en
  // el mismo pedido (p.ej. otro claim real creado en la misma transacción
  // que la cancelación), pero es la regla correcta de todos modos: nunca
  // ocultar dinero pendiente detrás de un reclamo genérico.
  if (notification.type === "cancellation" && notification.priority === "attention") {
    return 6
  }
  if (notification.type === "claim") return 5
  if (notification.type === "mercadolibre_return") return 5
  if (notification.type === "inventory") return 5
  if (notification.type === "payment") return 4
  if (notification.type === "shipping") return 3
  if (notification.type === "message") return 2
  if (notification.type === "invoice") return 1
  if (notification.type === "cancellation") return 1
  return 0
}

function sortByEventDate(a: { eventAt: string; stale?: boolean }, b: { eventAt: string; stale?: boolean }) {
  // Lo vencido (stale) siempre arriba, sin importar antigüedad -- si no, un
  // reintegro pendiente hace una semana queda enterrado debajo de una
  // cancelación recién creada y el admin nunca la vuelve a ver en la lista.
  const staleDiff = Number(Boolean(b.stale)) - Number(Boolean(a.stale))
  if (staleDiff !== 0) return staleDiff
  return getTime(b.eventAt) - getTime(a.eventAt)
}

export function keepLatestNotificationByOrder(notifications: AdminNotification[]) {
  const byOrder = new Map<number, AdminNotification>()
  const withoutOrder: AdminNotification[] = []

  for (const notification of notifications) {
    if (!notification.orderId) {
      withoutOrder.push(notification)
      continue
    }

    const current = byOrder.get(notification.orderId)
    const notificationTime = getTime(notification.eventAt)
    const currentTime = getTime(current?.eventAt)
    if (
      !current ||
      notificationTime > currentTime ||
      (notificationTime === currentTime &&
        getOperationalPriority(notification) > getOperationalPriority(current))
    ) {
      byOrder.set(notification.orderId, notification)
    }
  }

  return [...withoutOrder, ...byOrder.values()].sort(sortByEventDate)
}

export function keepDistinctOperationalTasks(notifications: AdminNotification[]) {
  return dedupeNotifications(notifications).sort((a, b) =>
    Number(Boolean(b.stale)) - Number(Boolean(a.stale)) ||
    getOperationalPriority(b) - getOperationalPriority(a) || sortByEventDate(a, b),
  )
}
