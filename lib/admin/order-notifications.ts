import { supabase } from "@/lib/supabase/client"

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
  orderCreatedAt: string,
  lastSeenAt: string | null
) {
  if (!lastSeenAt) return true

  return new Date(orderCreatedAt).getTime() > new Date(lastSeenAt).getTime()
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

export async function getNewOrderNotificationCount() {
  try {
    const adminId = await getCurrentAdminId()

    if (!adminId) return 0

    const view = await getAdminOrderView(adminId)

    if (!view.available) return 0

    const { data, error } = await supabase
      .from("ordenes")
      .select("payment_method_id, payment_id, payment_status")
      .gt("created_at", view.last_seen_at)

    if (error) {
      console.error(
        "ORDER_NOTIFICATIONS_COUNT_ERROR",
        getSupabaseErrorDetails(error)
      )
      return 0
    }

    return (data ?? []).filter(isVisibleAdminOrderNotification).length
  } catch (error) {
    console.error(
      "ORDER_NOTIFICATIONS_UNEXPECTED_ERROR",
      getSupabaseErrorDetails(error)
    )
    return 0
  }
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
