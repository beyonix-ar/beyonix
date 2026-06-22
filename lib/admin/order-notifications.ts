import { supabase } from "@/lib/supabase/client"
import type { SupabasePedido } from "@/lib/supabase/types"

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
  const dates = [order.created_at, order.return_requested_at]

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
  payment_method_id?: string | null
  payment_id?: string | null
  payment_status?: string | null
}) {
  if (order.payment_method_id === "transferencia") return true

  const isMercadoPago =
    order.payment_method_id === "mercadopago" ||
    Boolean(order.payment_id) ||
    ["pending_checkout", "pending", "rejected", "cancelled"].includes(
      order.payment_status ?? ""
    )

  return !isMercadoPago || order.payment_status === "approved"
}

export type AdminOrderNotificationTone = "order" | "message" | "issue"

export interface AdminOrderNotificationSummary {
  count: number
  tone: AdminOrderNotificationTone
}

const EMPTY_NOTIFICATION_SUMMARY: AdminOrderNotificationSummary = {
  count: 0,
  tone: "order",
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
        "id, created_at, return_requested_at, payment_method_id, payment_id, payment_status"
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
    const attentionOrderIds = new Set<number>(
      (orders ?? [])
        .filter(isVisibleAdminOrderNotification)
        .filter((order) =>
          [order.created_at, order.return_requested_at].some((date) =>
            isOrderNewerThanLastSeen(date, view.last_seen_at)
          )
        )
        .map((order) => order.id)
    )
    const issueOrderIds = new Set<number>(
      (orders ?? [])
        .filter(isVisibleAdminOrderNotification)
        .filter((order) =>
          isOrderNewerThanLastSeen(
            order.return_requested_at,
            view.last_seen_at,
          ),
        )
        .map((order) => order.id),
    )

    const { data: claims, error: claimsError } = await supabase
      .from("order_claims")
      .select("id, order_id")
      .eq("admin_needs_action", true)

    if (claimsError) {
      console.error(
        "ORDER_CLAIMS_NOTIFICATIONS_COUNT_ERROR",
        getSupabaseErrorDetails(claimsError)
      )
    } else {
      for (const claim of claims ?? []) {
        if (visibleOrderIds.has(claim.order_id)) {
          attentionOrderIds.add(claim.order_id)
          issueOrderIds.add(claim.order_id)
        }
      }
    }

    return {
      count: attentionOrderIds.size,
      tone: issueOrderIds.size > 0 ? "issue" : "order",
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
}
