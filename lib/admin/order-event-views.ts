import { supabase } from "@/lib/supabase/client"

const PAYMENT_PROOF_EVENT = "payment_proof"
const LOCAL_PREFIX = "beyonix-admin-payment-proof-seen"

function getTime(value?: string | null) {
  if (!value) return 0
  const time = new Date(value).getTime()
  return Number.isFinite(time) ? time : 0
}

function getLocalKey(adminId: string, orderId: number) {
  return `${LOCAL_PREFIX}:${adminId}:${orderId}`
}

function readLocalSeenAt(adminId: string, orderId: number) {
  if (typeof window === "undefined") return null
  return window.localStorage.getItem(getLocalKey(adminId, orderId))
}

function writeLocalSeenAt(adminId: string, orderId: number, eventAt: string) {
  if (typeof window === "undefined") return
  window.localStorage.setItem(getLocalKey(adminId, orderId), eventAt)
}

export async function getSeenAdminPaymentProofOrderIds(
  adminId: string,
  events: Array<{ id: number; eventAt?: string | null }>,
) {
  const seen = new Set<number>()
  if (events.length === 0) return seen

  const { data, error } = await supabase
    .from("admin_order_event_views")
    .select("order_id, event_at")
    .eq("admin_id", adminId)
    .eq("event_type", PAYMENT_PROOF_EVENT)
    .in("order_id", events.map((event) => event.id))

  if (!error) {
    const viewedAt = new Map(
      (data ?? []).map((row) => [Number(row.order_id), String(row.event_at)]),
    )
    for (const event of events) {
      if (getTime(viewedAt.get(event.id)) >= getTime(event.eventAt)) seen.add(event.id)
    }
    return seen
  }

  for (const event of events) {
    if (getTime(readLocalSeenAt(adminId, event.id)) >= getTime(event.eventAt)) {
      seen.add(event.id)
    }
  }
  return seen
}

export async function isAdminPaymentProofSeen(
  orderId: number,
  eventAt?: string | null,
) {
  if (!eventAt) return true
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return false

  const seen = await getSeenAdminPaymentProofOrderIds(user.id, [
    { id: orderId, eventAt },
  ])
  return seen.has(orderId)
}

export async function markAdminPaymentProofSeen(
  orderId: number,
  eventAt?: string | null,
) {
  if (!eventAt) return
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return

  writeLocalSeenAt(user.id, orderId, eventAt)
  const now = new Date().toISOString()
  await supabase.from("admin_order_event_views").upsert(
    {
      admin_id: user.id,
      order_id: orderId,
      event_type: PAYMENT_PROOF_EVENT,
      event_at: eventAt,
      seen_at: now,
      updated_at: now,
    },
    { onConflict: "admin_id,order_id,event_type" },
  )

  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("beyonix:order-notifications-changed"))
  }
}
