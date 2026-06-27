import { supabase } from "@/lib/supabase/client"
import { getSeenAdminPaymentProofOrderIds } from "@/lib/admin/order-event-views"
import { getPedidos } from "@/lib/supabase/queries/pedidos"

export const ADMIN_NOTIFICATIONS_CHANGED_EVENT =
  "beyonix:admin-notifications-changed"

export type AdminNotificationType =
  | "order"
  | "message"
  | "payment"
  | "invoice"
  | "shipping"
  | "cancellation"
  | "claim"

export type AdminNotificationTone = AdminNotificationType

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
}

export type AdminNotificationGroups = Record<AdminNotificationType, number>

export interface AdminNotificationSummary {
  count: number
  tone: AdminNotificationTone
  groups: AdminNotificationGroups
  notifications: AdminNotification[]
}

type AdminNotificationRead = {
  type: string
  event_key: string
  event_at: string
}

const EMPTY_GROUPS: AdminNotificationGroups = {
  order: 0,
  message: 0,
  payment: 0,
  invoice: 0,
  shipping: 0,
  cancellation: 0,
  claim: 0,
}

const EMPTY_SUMMARY: AdminNotificationSummary = {
  count: 0,
  tone: "order",
  groups: EMPTY_GROUPS,
  notifications: [],
}

const LOCAL_READ_PREFIX = "beyonix-admin-notification-read"

function getTime(value?: string | null) {
  if (!value) return 0
  const time = new Date(value).getTime()
  return Number.isFinite(time) ? time : 0
}

function sortByEventDate(
  a: { eventAt: string },
  b: { eventAt: string },
) {
  return getTime(b.eventAt) - getTime(a.eventAt)
}

function createGroups(): AdminNotificationGroups {
  return { ...EMPTY_GROUPS }
}

function getLocalReadKey(
  adminId: string,
  type: AdminNotificationType,
  eventKey: string,
) {
  return `${LOCAL_READ_PREFIX}:${adminId}:${type}:${eventKey}`
}

function readLocalEventAt(
  adminId: string,
  type: AdminNotificationType,
  eventKey: string,
) {
  if (typeof window === "undefined") return null
  return window.localStorage.getItem(getLocalReadKey(adminId, type, eventKey))
}

function writeLocalEventAt(
  adminId: string,
  type: AdminNotificationType,
  eventKey: string,
  eventAt: string,
) {
  if (typeof window === "undefined") return
  window.localStorage.setItem(getLocalReadKey(adminId, type, eventKey), eventAt)
}

export function getSupabaseErrorDetails(error: unknown) {
  const candidate =
    typeof error === "object" && error !== null
      ? (error as {
          message?: unknown
          details?: unknown
          hint?: unknown
          code?: unknown
        })
      : null

  return {
    message:
      typeof candidate?.message === "string"
        ? candidate.message
        : error instanceof Error
          ? error.message
          : String(error),
    details: candidate?.details,
    hint: candidate?.hint,
    code: candidate?.code,
    error,
  }
}

async function getCurrentAdminId() {
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser()

  if (error) {
    console.error(
      "ADMIN_NOTIFICATIONS_AUTH_ERROR",
      getSupabaseErrorDetails(error),
    )
    return null
  }

  return user?.id ?? null
}

async function getOrderLastSeenAt(adminId: string) {
  const { data, error } = await supabase
    .from("admin_order_views")
    .select("last_seen_at")
    .eq("admin_id", adminId)
    .maybeSingle()

  if (error) return null

  return typeof data?.last_seen_at === "string" ? data.last_seen_at : null
}

function isOrderVisible(order: { id?: number | null }) {
  return typeof order.id === "number" && Number.isFinite(order.id)
}

function isOrderPaidForInvoice(order: {
  estado?: string | null
  payment_status?: string | null
  total?: number | null
}) {
  if (Number(order.total ?? 0) <= 0) return false
  if (["rechazado", "rejected"].includes(order.payment_status ?? "")) {
    return false
  }

  return (
    order.payment_status === "confirmado" ||
    order.payment_status === "approved" ||
    ["pagado", "enviado", "en_camino", "entregado"].includes(
      order.estado ?? "",
    )
  )
}

function isPaymentReceived(order: {
  payment_status?: string | null
  paid_at?: string | null
}) {
  return Boolean(order.paid_at) ||
    ["confirmado", "approved", "confirmed"].includes(
      order.payment_status ?? "",
    )
}

function hasPaymentProofPendingReview(order: {
  payment_status?: string | null
  payment_proof_url?: string | null
}) {
  return Boolean(order.payment_proof_url) &&
    ["en_revision", "pendiente_comprobante", "pending"].includes(
      order.payment_status ?? "",
    )
}

function isOrderReadyForShipping(order: {
  estado?: string | null
  invoice_status?: string | null
  invoice_cae?: string | null
}) {
  if (order.invoice_status !== "authorized" || !order.invoice_cae) return false

  return ![
    "preparado",
    "enviado",
    "en_camino",
    "entregado",
    "cancelado",
    "rechazado",
  ].includes(order.estado ?? "")
}

function claimNeedsAdminAttention(claim: {
  admin_needs_action?: boolean | null
  first_reviewed_at?: string | null
  last_customer_message_at?: string | null
  status?: string | null
}) {
  if (claim.admin_needs_action) return true
  if (["cerrado", "rechazado"].includes(claim.status ?? "")) return false
  if (!claim.first_reviewed_at) return true
  return Boolean(claim.last_customer_message_at)
}

function formatOrderId(orderId: number) {
  return `#BX-${1000 + orderId}`
}

async function loadReads(
  adminId: string,
  notifications: AdminNotification[],
) {
  const reads = new Map<string, string>()
  if (notifications.length === 0) return reads

  const eventKeys = notifications.map((notification) => notification.eventKey)

  const { data, error } = await supabase
    .from("admin_notification_reads")
    .select("type, event_key, event_at")
    .eq("admin_id", adminId)
    .in("event_key", eventKeys)

  if (!error) {
    for (const row of (data ?? []) as AdminNotificationRead[]) {
      reads.set(`${row.type}:${row.event_key}`, row.event_at)
    }
    return reads
  }

  console.warn(
    "ADMIN_NOTIFICATION_READS_LOAD_ERROR",
    getSupabaseErrorDetails(error),
  )

  for (const notification of notifications) {
    const localEventAt = readLocalEventAt(
      adminId,
      notification.type,
      notification.eventKey,
    )
    if (localEventAt) {
      reads.set(`${notification.type}:${notification.eventKey}`, localEventAt)
    }
  }

  return reads
}

function applyReads(
  notifications: AdminNotification[],
  reads: Map<string, string>,
) {
  return notifications
    .map((notification) => {
      if (
        notification.type === "payment" ||
        notification.type === "shipping"
      ) {
        return {
          ...notification,
          isRead: false,
        }
      }

      const readEventAt = reads.get(
        `${notification.type}:${notification.eventKey}`,
      )

      return {
        ...notification,
        isRead: getTime(readEventAt) >= getTime(notification.eventAt),
      }
    })
    .filter((notification) => !notification.isRead)
    .sort(sortByEventDate)
}

function dedupeNotifications(notifications: AdminNotification[]) {
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

function keepLatestNotificationByOrder(notifications: AdminNotification[]) {
  const byOrder = new Map<number, AdminNotification>()
  const withoutOrder: AdminNotification[] = []

  for (const notification of notifications) {
    if (!notification.orderId) {
      withoutOrder.push(notification)
      continue
    }

    const current = byOrder.get(notification.orderId)
    if (!current || getTime(notification.eventAt) > getTime(current.eventAt)) {
      byOrder.set(notification.orderId, notification)
    }
  }

  return [...withoutOrder, ...byOrder.values()].sort(sortByEventDate)
}

function getCancellationNotificationContent(
  order: {
    id: number
    payment_status?: string | null
    payment_proof_url?: string | null
    paid_at?: string | null
  },
) {
  const orderCode = formatOrderId(order.id)

  if (isPaymentReceived(order)) {
    return {
      title: "Compra cancelada con pago recibido",
      body: `El pedido ${orderCode} fue cancelado por el cliente y tiene un pago recibido. Revisá la gestión del reintegro o crédito.`,
      priority: "attention" as const,
    }
  }

  if (hasPaymentProofPendingReview(order)) {
    return {
      title: "Compra cancelada con comprobante cargado",
      body: `El pedido ${orderCode} fue cancelado por el cliente y tenía un comprobante pendiente de revisión.`,
      priority: "attention" as const,
    }
  }

  return {
    title: "Compra cancelada",
    body: `El pedido ${orderCode} fue cancelado por el cliente.`,
  }
}

function getTone(groups: AdminNotificationGroups): AdminNotificationTone {
  if (groups.claim > 0) return "claim"
  if (groups.cancellation > 0) return "cancellation"
  if (groups.shipping > 0) return "shipping"
  if (groups.message > 0) return "message"
  if (groups.payment > 0) return "payment"
  if (groups.invoice > 0) return "invoice"
  return "order"
}

function buildSummary(notifications: AdminNotification[]): AdminNotificationSummary {
  const groups = createGroups()

  for (const notification of notifications) {
    groups[notification.type] += 1
  }

  return {
    count: notifications.length,
    tone: getTone(groups),
    groups,
    notifications,
  }
}

export async function getAdminNotifications(): Promise<AdminNotificationSummary> {
  try {
    const adminId = await getCurrentAdminId()
    if (!adminId) return EMPTY_SUMMARY

    const [
      pedidos,
      orderLastSeenAt,
    ] = await Promise.all([
      getPedidos(),
      getOrderLastSeenAt(adminId),
    ])

    const orders = pedidos.filter(isOrderVisible)
    const orderIds = new Set(orders.map((order) => Number(order.id)))
    const paymentProofEvents = orders
      .filter(
        (order) =>
          order.payment_proof_url &&
          order.payment_status === "en_revision" &&
          order.payment_proof_uploaded_at,
      )
      .map((order) => ({
        id: Number(order.id),
        eventAt: String(order.payment_proof_uploaded_at),
      }))
    const seenPaymentProofOrderIds = await getSeenAdminPaymentProofOrderIds(
      adminId,
      paymentProofEvents,
    )
    const rawClaims = orders.flatMap((order) =>
      (order.order_claims ?? []).map((claim) => ({
        ...claim,
        order_id: claim.order_id ?? order.id,
      })),
    )
    const claims = [...new Map(rawClaims.map((claim) => [claim.id, claim])).values()]
    const claimsById = new Map(
      claims.map((claim) => [Number(claim.id), claim]),
    )
    const customerMessages = claims
      .flatMap((claim) =>
        (claim.order_claim_messages ?? []).map((message) => ({
          ...message,
          claim_id: message.claim_id ?? claim.id,
        })),
      )
      .filter((message) => message.author_role === "cliente")
      .sort((a, b) => getTime(b.created_at) - getTime(a.created_at))
      .slice(0, 200)
    const notifications: AdminNotification[] = []

    for (const order of orders) {
      const orderId = Number(order.id)
      const createdAt = String(order.created_at)

      if (!orderLastSeenAt || getTime(createdAt) > getTime(orderLastSeenAt)) {
        notifications.push({
          id: `order:${orderId}`,
          type: "order",
          eventKey: `order:${orderId}`,
          eventAt: createdAt,
          title: "Pedido nuevo",
          body: `Ingresó el pedido ${formatOrderId(orderId)}.`,
          actionUrl: `/admin/pedidos/${orderId}`,
          orderId,
          isRead: false,
        })
      }

      if (
        order.payment_proof_url &&
        order.payment_status === "en_revision" &&
        order.payment_proof_uploaded_at &&
        !seenPaymentProofOrderIds.has(orderId)
      ) {
        notifications.push({
          id: `payment:${orderId}`,
          type: "payment",
          eventKey: `payment:${orderId}`,
          eventAt: String(order.payment_proof_uploaded_at),
          title: "Nuevo comprobante recibido",
          body: `Pedido ${formatOrderId(orderId)}`,
          actionLabel: "Ver comprobante",
          actionUrl: `/admin/pedidos/${orderId}?tab=pago`,
          orderId,
          isRead: false,
        })
      }

      if (
        isOrderPaidForInvoice(order) &&
        !order.invoice_cae &&
        (
          order.invoice_status == null ||
          order.invoice_status === "pending" ||
          order.invoice_status === "error"
        )
      ) {
        notifications.push({
          id: `invoice:${orderId}`,
          type: "invoice",
          eventKey: `invoice:${orderId}`,
          eventAt: String(order.paid_at || order.created_at),
          title: "Factura por emitir",
          body: `El pedido ${formatOrderId(orderId)} está listo para facturar.`,
          actionUrl: `/admin/pedidos/${orderId}?tab=pago`,
          orderId,
          isRead: false,
        })
      }

      if (isOrderReadyForShipping(order)) {
        notifications.push({
          id: `shipping:${orderId}`,
          type: "shipping",
          eventKey: `shipping:${orderId}`,
          eventAt: String(
            order.invoice_created_at || order.paid_at || order.created_at,
          ),
          title: "Envío pendiente",
          body: `El pedido ${formatOrderId(orderId)} ya está facturado y listo para preparar/enviar.`,
          actionLabel: "Ver envío",
          actionUrl: `/admin/pedidos/${orderId}?tab=envio`,
          orderId,
          isRead: false,
        })
      }

      if (order.estado === "cancelado") {
        const cancelledAt =
          (order as { cancelled_at?: string | null }).cancelled_at

        if (!cancelledAt) continue
        const cancellationContent = getCancellationNotificationContent({
          id: orderId,
          payment_status: order.payment_status,
          payment_proof_url: order.payment_proof_url,
          paid_at: order.paid_at,
        })

        notifications.push({
          id: `order-cancelled:${orderId}`,
          type: "cancellation",
          eventKey: `order-cancelled:${orderId}`,
          eventAt: String(cancelledAt),
          title: cancellationContent.title,
          body: cancellationContent.body,
          actionUrl: `/admin/pedidos/${orderId}`,
          orderId,
          isRead: false,
          priority: cancellationContent.priority,
        })
      }
    }

    for (const claim of claims) {
      if (!claimNeedsAdminAttention(claim)) continue

      const orderId = Number(claim.order_id)
      notifications.push({
        id: `claim:${claim.id}`,
        type: "claim",
        eventKey: `claim:${claim.id}`,
        eventAt: String(
          claim.last_customer_message_at || claim.created_at,
        ),
        title: "Reclamo por responder",
        body: `El reclamo del pedido ${formatOrderId(orderId)} requiere atención.`,
        actionUrl: `/admin/pedidos/${orderId}?tab=reclamos`,
        orderId,
        isRead: false,
      })
    }

    for (const message of customerMessages) {
      const claim = claimsById.get(Number(message.claim_id))
      if (!claim?.first_reviewed_at) continue
      if (claimNeedsAdminAttention(claim)) continue
      if (!orderIds.has(Number(claim.order_id))) continue

      const orderId = Number(claim.order_id)
      const body =
        typeof message.message === "string" && message.message.trim()
          ? message.message.trim()
          : `Nuevo mensaje en el pedido ${formatOrderId(orderId)}.`

      notifications.push({
        id: `message:${message.id}`,
        type: "message",
        eventKey: `message:${message.id}`,
        eventAt: String(message.created_at),
        title: "Mensaje nuevo",
        body: body.length > 110 ? `${body.slice(0, 107)}...` : body,
        actionUrl: `/admin/pedidos/${orderId}?tab=reclamos`,
        orderId,
        isRead: false,
      })
    }

    const dedupedNotifications = dedupeNotifications(notifications)
    const latestNotifications = keepLatestNotificationByOrder(dedupedNotifications)
    const reads = await loadReads(adminId, latestNotifications)
    return buildSummary(applyReads(latestNotifications, reads))
  } catch (error) {
    console.error(
      "ADMIN_NOTIFICATIONS_UNEXPECTED_ERROR",
      getSupabaseErrorDetails(error),
    )
    return EMPTY_SUMMARY
  }
}

async function markNotificationsRead(
  notifications: AdminNotification[],
) {
  if (notifications.length === 0) return

  const adminId = await getCurrentAdminId()
  if (!adminId) return

  const now = new Date().toISOString()
  const rows = notifications.map((notification) => {
    writeLocalEventAt(
      adminId,
      notification.type,
      notification.eventKey,
      notification.eventAt,
    )

    return {
      admin_id: adminId,
      type: notification.type,
      event_key: notification.eventKey,
      event_at: notification.eventAt,
      read_at: now,
      updated_at: now,
    }
  })

  const { error } = await supabase
    .from("admin_notification_reads")
    .upsert(rows, { onConflict: "admin_id,type,event_key" })

  if (error) {
    console.warn(
      "ADMIN_NOTIFICATION_READS_UPSERT_ERROR",
      getSupabaseErrorDetails(error),
    )
  }

  notifyAdminNotificationsChanged()
}

export async function markAdminNotificationRead(
  notification: AdminNotification,
) {
  await markNotificationsRead([notification])
}

export async function markAdminOrderNewNotificationRead(orderId: number) {
  const summary = await getAdminNotifications()
  const notification = summary.notifications.find(
    (item) => item.type === "order" && item.orderId === orderId,
  )

  if (!notification) return

  await markNotificationsRead([notification])
}

export async function markAdminShippingNotificationRead(orderId: number) {
  const summary = await getAdminNotifications()
  const notification = summary.notifications.find(
    (item) => item.type === "shipping" && item.orderId === orderId,
  )

  if (!notification) return

  await markNotificationsRead([notification])
}

export async function markAdminClaimNotificationsRead(orderId: number) {
  const summary = await getAdminNotifications()
  const notifications = summary.notifications.filter(
    (item) => item.type === "claim" && item.orderId === orderId,
  )

  if (notifications.length === 0) return

  await markNotificationsRead(notifications)
}

export function notifyAdminNotificationsChanged() {
  if (typeof window === "undefined") return
  window.dispatchEvent(new Event(ADMIN_NOTIFICATIONS_CHANGED_EVENT))
}
