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
import { isClaimVisibleForMode } from "../orders/claim-visibility.ts"
import {
  getCancellationNextAction,
  getCancellationNextActionCopy,
  type CancellationNextActionOrder,
  type CancellationNextActionState,
} from "../orders/cancellation-next-action.ts"

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

export function claimNeedsAdminAttention(claim: {
  admin_needs_action?: boolean | null
  first_reviewed_at?: string | null
  last_customer_message_at?: string | null
  last_admin_response_at?: string | null
  status?: string | null
}) {
  if (claim.admin_needs_action) return true
  if (["cerrado", "rechazado"].includes(claim.status ?? "")) return false
  if (!claim.first_reviewed_at) return true
  return getTime(claim.last_customer_message_at) > getTime(claim.last_admin_response_at)
}

export interface CancellationNotificationOrder extends CancellationNextActionOrder {
  id: number
  created_at?: string | null
  cancelled_at?: string | null
  cancellation_requested_at?: string | null
  refund_pending_at?: string | null
}

/**
 * Umbral a partir del cual una acción de cancelación pendiente se marca
 * `stale` (ver AdminNotification.stale). needs_reconciliation es dinero en
 * un estado ambiguo frente a Mercado Pago -- se vuelve crítico mucho antes
 * que el resto. `null` = ese estado nunca se marca stale (wait_credit_note
 * depende de ARCA, no de una acción del admin).
 */
const STALE_THRESHOLD_MS_BY_STATE: Partial<Record<CancellationNextActionState, number>> = {
  reconcile_mp_refund: 6 * 60 * 60 * 1000,
  emit_credit_note: 48 * 60 * 60 * 1000,
  register_external_refund: 48 * 60 * 60 * 1000,
  execute_mp_refund: 48 * 60 * 60 * 1000,
  blocked: 24 * 60 * 60 * 1000,
}

/**
 * Única fuente de "qué necesita este pedido cancelado ahora" -- ver
 * lib/orders/cancellation-next-action.ts. Reemplaza el criterio anterior
 * (hasCancellationAdminAttention + texto ad-hoc por financial_status), que
 * no distinguía "falta emitir NC" de "falta cargar comprobante" de "hay que
 * revisar un refund de Mercado Pago". Devuelve `null` cuando no hay nada
 * pendiente (sin pago confirmado, o ya resuelto) -- así la notificación
 * desaparece sola en el siguiente poll en vez de quedar una alerta de algo
 * ya resuelto.
 */
export function buildCancellationNotification(
  order: CancellationNotificationOrder,
  now: number = Date.now(),
): AdminNotification | null {
  const nextAction = getCancellationNextAction(order)
  const copy = getCancellationNextActionCopy(nextAction.state, nextAction.reason)
  if (!copy) return null

  const cancelledAt =
    order.refund_pending_at || order.cancellation_requested_at || order.cancelled_at
  if (!cancelledAt) return null

  const orderId = order.id
  const orderCode = formatOrderId(orderId)
  const eventKey = `cancellation:${nextAction.state}:${orderId}`
  const threshold = STALE_THRESHOLD_MS_BY_STATE[nextAction.state]
  const stale = Boolean(threshold && now - getTime(String(cancelledAt)) > threshold)

  return {
    id: eventKey,
    type: "cancellation",
    eventKey,
    eventAt: String(cancelledAt),
    title: copy.title,
    body: `${orderCode} — ${copy.description}`,
    actionLabel: copy.title,
    actionUrl: `${ADMIN_ROUTES.pedidos}/${orderId}?tab=${copy.tab}`,
    orderId,
    isRead: false,
    priority: nextAction.urgent ? "attention" : undefined,
    stale,
  }
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
    actionUrl: `${ADMIN_ROUTES.pedidos}/${orderId}?tab=reclamos`,
    orderId,
    isRead: false,
  }
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
