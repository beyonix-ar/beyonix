import { supabase } from "@/lib/supabase/client"
import type { SupabasePedido } from "@/lib/supabase/types"
import { notifyAdminNotificationsChanged } from "@/lib/admin/admin-notifications"

export const ORDER_NOTIFICATIONS_CHANGED_EVENT =
  "beyonix:order-notifications-changed"

interface AdminOrderView {
  last_seen_at: string
  available: boolean
}

const DEFAULT_LAST_SEEN_AT = "2000-01-01T00:00:00.000Z"

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
      "ORDER_NOTIFICATIONS_AUTH_ERROR",
      getSupabaseErrorDetails(error)
    )
    return null
  }

  if (!user) return null

  return user.id
}

async function getAdminOrderView(adminId: string) {
  const { data, error } = await supabase
    .from("admin_order_views")
    .select("last_seen_at")
    .eq("admin_id", adminId)
    .maybeSingle()

  if (error) {
    console.error(
      "ADMIN_ORDER_VIEW_LOAD_ERROR",
      getSupabaseErrorDetails(error)
    )
    return {
      last_seen_at: DEFAULT_LAST_SEEN_AT,
      available: false,
    }
  }

  return {
    last_seen_at: data?.last_seen_at ?? DEFAULT_LAST_SEEN_AT,
    available: true,
  }
}

export async function getAdminOrderLastSeenAt() {
  const adminId = await getCurrentAdminId()

  if (!adminId) return null

  const view = await getAdminOrderView(adminId)
  return view.available ? view.last_seen_at : null
}

export function isOrderNewerThanLastSeen(
  orderCreatedAt: string | null | undefined,
  lastSeenAt: string | null
) {
  if (!orderCreatedAt) return false
  if (!lastSeenAt) return true

  return new Date(orderCreatedAt).getTime() > new Date(lastSeenAt).getTime()
}

function getTime(value?: string | null) {
  if (!value) return 0

  const time = new Date(value).getTime()
  return Number.isFinite(time) ? time : 0
}

export function getOrderAttentionAt(order: SupabasePedido) {
  const dates = [
    order.created_at,
    order.return_requested_at,
    order.payment_proof_uploaded_at,
    order.cancellation_requested_at,
    order.refund_pending_at,
    order.refund_uploaded_at,
    order.refunded_at,
  ]

  for (const claim of order.order_claims ?? []) {
    if (typeof claim.admin_needs_action === "boolean") continue
    dates.push(claim.created_at)

    for (const message of claim.order_claim_messages ?? []) {
      if (message.author_role === "cliente") {
        dates.push(message.created_at)
      }
    }
  }

  const latestTime = Math.max(...dates.map(getTime))
  return latestTime > 0 ? new Date(latestTime).toISOString() : null
}

export function orderHasPendingClaimAction(order: SupabasePedido) {
  return (order.order_claims ?? []).some((claim) => claim.admin_needs_action === true)
}

function isPaymentReceived(order: {
  payment_status?: string | null
  paid_at?: string | null
  payment_confirmed_amount?: number | string | null
}) {
  return (
    Boolean(order.paid_at) ||
    Number(order.payment_confirmed_amount ?? 0) > 0 ||
    ["confirmado", "approved", "confirmed"].includes(order.payment_status ?? "")
  )
}

function hasRefundAttentionPending(order: {
  estado?: string | null
  financial_status?: string | null
  payment_status?: string | null
  paid_at?: string | null
  payment_confirmed_amount?: number | string | null
}) {
  if (order.financial_status === "refunded" || order.financial_status === "cancelled") {
    return false
  }
  if (order.financial_status === "refund_pending") return true
  if (order.financial_status === "cancellation_requested") {
    return isPaymentReceived(order)
  }

  return order.estado === "cancelado" && isPaymentReceived(order)
}

export function hasOrderAttentionAfter(
  order: SupabasePedido,
  lastSeenAt: string | null
) {
  if (!lastSeenAt) return true

  const attentionAt = getOrderAttentionAt(order)
  if (!attentionAt) return false

  return getTime(attentionAt) > getTime(lastSeenAt)
}

function isVisibleAdminOrderNotification(order: {
  id?: number
  payment_method_id?: string | null
  payment_id?: string | null
  payment_status?: string | null
}) {
  return typeof order.id === "number" && Number.isFinite(order.id)
}

export type AdminOrderNotificationTone = "order" | "message" | "issue" | "invoice"

export interface AdminOrderNotificationSummary {
  count: number
  tone: AdminOrderNotificationTone
  groups: AdminOrderNotificationGroups
}

export interface AdminOrderNotificationGroups {
  order: number
  message: number
  issue: number
  invoice: number
}

const EMPTY_NOTIFICATION_SUMMARY: AdminOrderNotificationSummary = {
  count: 0,
  tone: "order",
  groups: {
    order: 0,
    message: 0,
    issue: 0,
    invoice: 0,
  },
}

export async function getNewOrderNotificationSummary(): Promise<AdminOrderNotificationSummary> {
  try {
    const adminId = await getCurrentAdminId()

    if (!adminId) return EMPTY_NOTIFICATION_SUMMARY

    const view = await getAdminOrderView(adminId)

    if (!view.available) return EMPTY_NOTIFICATION_SUMMARY

    const { data: orders, error } = await supabase
      .from("ordenes")
      .select(
        "id, created_at, return_requested_at, cancellation_requested_at, refund_pending_at, refund_uploaded_at, refunded_at, estado, total, payment_method_id, payment_id, payment_status, payment_proof_url, payment_proof_uploaded_at, payment_confirmed_amount, paid_at, financial_status, invoice_status"
      )

    if (error) {
      console.error(
        "ORDER_NOTIFICATIONS_COUNT_ERROR",
        getSupabaseErrorDetails(error)
      )
      return EMPTY_NOTIFICATION_SUMMARY
    }

    const visibleOrderIds = new Set(
      (orders ?? [])
        .filter(isVisibleAdminOrderNotification)
        .map((order) => order.id)
    )
    const newOrderIds = new Set<number>(
      (orders ?? [])
        .filter(isVisibleAdminOrderNotification)
        .filter((order) =>
          isOrderNewerThanLastSeen(order.created_at, view.last_seen_at)
        )
        .map((order) => order.id)
    )
    const proofEvents = (orders ?? [])
      .filter(isVisibleAdminOrderNotification)
      .filter(
        (order) =>
          Boolean(order.payment_proof_url) &&
          order.payment_status === "en_revision" &&
          Boolean(order.payment_proof_uploaded_at),
      )
      .map((order) => ({
        id: order.id,
        eventAt: order.payment_proof_uploaded_at,
      }))
    const messageOrderIds = new Set<number>(
      proofEvents
        .map((event) => event.id),
    )
    const issueOrderIds = new Set<number>(
      (orders ?? [])
        .filter(isVisibleAdminOrderNotification)
        .filter((order) =>
          hasRefundAttentionPending(order) ||
          isOrderNewerThanLastSeen(order.return_requested_at, view.last_seen_at),
        )
        .map((order) => order.id),
    )

    const { data: claims, error: claimsError } = await supabase
      .from("order_claims")
      .select("id, order_id, first_reviewed_at, last_customer_message_at")
      .eq("admin_needs_action", true)

    if (claimsError) {
      console.error(
        "ORDER_CLAIMS_NOTIFICATIONS_COUNT_ERROR",
        getSupabaseErrorDetails(claimsError)
      )
    } else {
      for (const claim of claims ?? []) {
        if (visibleOrderIds.has(claim.order_id)) {
          issueOrderIds.add(claim.order_id)
          if (
            claim.first_reviewed_at &&
            isOrderNewerThanLastSeen(
              claim.last_customer_message_at,
              view.last_seen_at,
            )
          ) {
            messageOrderIds.add(claim.order_id)
          }
        }
      }
    }

    const groups: AdminOrderNotificationGroups = {
      order: newOrderIds.size,
      message: messageOrderIds.size,
      issue: issueOrderIds.size,
      invoice: (orders ?? []).filter(
        (order) =>
          isVisibleAdminOrderNotification(order) &&
          Number(order.total ?? 0) > 0 &&
          order.estado !== "cancelado" &&
          !["cancelled", "cancellation_requested", "refund_pending", "refunded"].includes(
            order.financial_status ?? "",
          ) &&
          !["rechazado", "rejected"].includes(order.payment_status ?? "") &&
          (order.payment_status === "confirmado" ||
            order.payment_status === "approved" ||
            ["pagado", "enviado", "en_camino", "entregado"].includes(
              order.estado ?? "",
            )) &&
          order.invoice_status !== "authorized",
      ).length,
    }

    return {
      count: groups.order + groups.message + groups.issue + groups.invoice,
      tone:
        groups.issue > 0
          ? "issue"
          : groups.message > 0
            ? "message"
            : groups.invoice > 0
              ? "invoice"
              : "order",
      groups,
    }
  } catch (error) {
    console.error(
      "ORDER_NOTIFICATIONS_UNEXPECTED_ERROR",
      getSupabaseErrorDetails(error)
    )
    return EMPTY_NOTIFICATION_SUMMARY
  }
}

export async function getNewOrderNotificationCount() {
  return (await getNewOrderNotificationSummary()).count
}

export async function markOrdersSeenAndGetPreviousLastSeen() {
  try {
    const adminId = await getCurrentAdminId()

    if (!adminId) return null

    const view = await getAdminOrderView(adminId)
    const now = new Date().toISOString()
    const { error } = await supabase
      .from("admin_order_views")
      .upsert(
        {
          admin_id: adminId,
          last_seen_at: now,
          updated_at: now,
        },
        { onConflict: "admin_id" }
      )

    if (error) {
      console.error(
        "ADMIN_ORDER_VIEW_UPSERT_ERROR",
        getSupabaseErrorDetails(error)
      )
      return view.available ? view.last_seen_at : null
    }

    notifyOrderNotificationsChanged()

    return view.available ? view.last_seen_at : null
  } catch (error) {
    console.error(
      "ADMIN_ORDER_VIEW_UNEXPECTED_ERROR",
      getSupabaseErrorDetails(error)
    )
    return null
  }
}

export function notifyOrderNotificationsChanged() {
  if (typeof window === "undefined") return

  window.dispatchEvent(new Event(ORDER_NOTIFICATIONS_CHANGED_EVENT))
  notifyAdminNotificationsChanged()
}
