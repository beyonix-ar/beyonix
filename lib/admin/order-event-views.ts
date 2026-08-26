import { getSafeSupabaseSession } from "@/lib/supabase/client"

const PAYMENT_PROOF_EVENT = "payment_proof"
const ORDER_SUMMARY_EVENT = "order_summary"
const LOCAL_PREFIX = "beyonix-admin-payment-proof-seen"

function getTime(value?: string | null) {
  if (!value) return 0
  const time = new Date(value).getTime()
  return Number.isFinite(time) ? time : 0
}

function getLocalKey(adminId: string, orderId: number) {
  return `${LOCAL_PREFIX}:${adminId}:${orderId}`
}

function getGenericLocalKey(adminId: string, orderId: number, eventType: string) {
  return `${LOCAL_PREFIX}:${eventType}:${adminId}:${orderId}`
}

function writeLocalSeenAt(adminId: string, orderId: number, eventAt: string) {
  if (typeof window === "undefined") return
  window.localStorage.setItem(getLocalKey(adminId, orderId), eventAt)
}

async function getAdminAccessToken() {
  const session = await getSafeSupabaseSession()
  return session?.access_token ?? null
}

async function loadEventViews(orderIds: number[], eventType: string) {
  const token = await getAdminAccessToken()
  if (!token || orderIds.length === 0) return null

  const search = new URLSearchParams({
    eventType,
    orderIds: orderIds.join(","),
  })
  const response = await fetch(`/api/admin/order-event-views?${search}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  })
  if (!response.ok) return null

  const result = (await response.json()) as {
    views?: Array<{ order_id: number; event_at: string }>
  }
  return result.views ?? []
}

async function persistEventView(
  orderId: number,
  eventType: string,
  eventAt: string,
) {
  const token = await getAdminAccessToken()
  if (!token) return

  await fetch("/api/admin/order-event-views", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ orderId, eventType, eventAt }),
  })
}

export async function markAdminPaymentProofSeen(
  orderId: number,
  eventAt?: string | null,
) {
  if (!eventAt) return
  const session = await getSafeSupabaseSession()
  if (!session?.user) return

  writeLocalSeenAt(session.user.id, orderId, eventAt)
  await persistEventView(orderId, PAYMENT_PROOF_EVENT, eventAt)

  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("beyonix:order-notifications-changed"))
  }
}

async function isAdminOrderEventSeen(
  orderId: number,
  eventType: string,
  eventAt?: string | null,
) {
  if (!eventAt) return true
  const session = await getSafeSupabaseSession()
  if (!session?.user) return false

  const data = await loadEventViews([orderId], eventType)
  const view = data?.[0]

  if (view?.event_at) {
    return getTime(view.event_at) >= getTime(eventAt)
  }

  if (typeof window === "undefined") return false
  return (
    getTime(window.localStorage.getItem(getGenericLocalKey(session.user.id, orderId, eventType))) >=
    getTime(eventAt)
  )
}

async function markAdminOrderEventSeen(
  orderId: number,
  eventType: string,
  eventAt?: string | null,
) {
  if (!eventAt) return
  const session = await getSafeSupabaseSession()
  if (!session?.user) return

  if (typeof window !== "undefined") {
    window.localStorage.setItem(getGenericLocalKey(session.user.id, orderId, eventType), eventAt)
  }

  await persistEventView(orderId, eventType, eventAt)

  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("beyonix:order-notifications-changed"))
  }
}

export function isAdminOrderSummarySeen(orderId: number, eventAt?: string | null) {
  return isAdminOrderEventSeen(orderId, ORDER_SUMMARY_EVENT, eventAt)
}

export function markAdminOrderSummarySeen(orderId: number, eventAt?: string | null) {
  return markAdminOrderEventSeen(orderId, ORDER_SUMMARY_EVENT, eventAt)
}
