import { isIP } from "node:net"

import { databaseErrorResponse } from "@/lib/admin/database-error-response"
import {
  getReservationAbuseStatus,
  isReservationBlockAction,
  type ReservationAbuseAccount,
  type ReservationAbuseDetail,
  type ReservationAbuseEventType,
  type ReservationAbuseItem,
  type ReservationAbuseStateRow,
  type ReservationIpBlock,
} from "@/lib/admin/reservation-abuse"
import type { createAdminClient } from "@/lib/supabase/admin"

import { requireAdmin } from "../_auth"

type AdminClient = ReturnType<typeof createAdminClient>

const ERROR_MESSAGE = "No se pudo cargar la protección de reservas. Intentá de nuevo."
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface StoredItem {
  product_id: number
  variant_id: number | null
  conditioned_stock_id: string | null
  quantity: number
}

function toStoredItems(value: unknown): StoredItem[] {
  return Array.isArray(value)
    ? value.filter((item): item is StoredItem =>
        Boolean(item) && typeof item === "object" && typeof (item as StoredItem).product_id === "number")
    : []
}

async function loadDetail(admin: AdminClient, userId: string): Promise<ReservationAbuseDetail | null> {
  const [eventsResult, candidatesResult] = await Promise.all([
    admin.from("reservation_abuse_events")
      .select("id, event_type, created_at, client_ip, order_id, details")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(50),
    admin.from("reservation_abuse_candidates")
      .select("session_id, created_at, reserved_units, items, emptied_items, client_ip, outcome")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(20),
  ])
  if (eventsResult.error || candidatesResult.error) return null

  const candidates = candidatesResult.data ?? []
  const sessionIds = candidates.map((candidate) => candidate.session_id)
  const allItems = candidates.flatMap((candidate) => [
    ...toStoredItems(candidate.items),
    ...toStoredItems(candidate.emptied_items),
  ])
  const productIds = [...new Set(allItems.map((item) => item.product_id))]
  const variantIds = [...new Set(allItems.flatMap((item) => (item.variant_id ? [item.variant_id] : [])))]
  const [sessionsResult, productsResult, variantsResult] = await Promise.all([
    sessionIds.length
      ? admin.from("checkout_reservation_sessions").select("session_id, order_id").in("session_id", sessionIds)
      : Promise.resolve({ data: [], error: null }),
    productIds.length
      ? admin.from("productos").select("id, nombre").in("id", productIds)
      : Promise.resolve({ data: [], error: null }),
    variantIds.length
      ? admin.from("producto_variantes").select("id, nombre").in("id", variantIds)
      : Promise.resolve({ data: [], error: null }),
  ])
  if (sessionsResult.error || productsResult.error || variantsResult.error) return null

  const orderBySession = new Map((sessionsResult.data ?? []).map((row) => [row.session_id, row.order_id]))
  const productNames = new Map((productsResult.data ?? []).map((row) => [row.id, row.nombre]))
  const variantNames = new Map((variantsResult.data ?? []).map((row) => [row.id, row.nombre]))
  const describe = (item: StoredItem): ReservationAbuseItem => ({
    productId: item.product_id,
    variantId: item.variant_id,
    conditionedStockId: item.conditioned_stock_id,
    quantity: item.quantity,
    productName: productNames.get(item.product_id) ?? null,
    variantName: item.variant_id ? variantNames.get(item.variant_id) ?? null : null,
  })

  return {
    events: (eventsResult.data ?? []).map((event) => ({
      id: event.id,
      type: event.event_type as ReservationAbuseEventType,
      createdAt: event.created_at,
      clientIp: event.client_ip,
      orderId: event.order_id,
      details: event.details ?? {},
    })),
    reservations: candidates.map((candidate) => ({
      sessionId: candidate.session_id,
      createdAt: candidate.created_at,
      reservedUnits: candidate.reserved_units,
      items: toStoredItems(candidate.items).map(describe),
      emptiedItems: toStoredItems(candidate.emptied_items).map(describe),
      clientIp: candidate.client_ip,
      outcome: candidate.outcome,
      orderId: orderBySession.get(candidate.session_id) ?? null,
    })),
  }
}

export async function GET(request: Request) {
  const auth = await requireAdmin(request)
  if ("error" in auth) return auth.error

  const userId = new URL(request.url).searchParams.get("userId")
  if (userId) {
    if (!UUID_PATTERN.test(userId)) return Response.json({ error: "Cuenta inválida." }, { status: 400 })
    const detail = await loadDetail(auth.admin, userId)
    return detail ? Response.json({ detail }) : Response.json({ error: ERROR_MESSAGE }, { status: 500 })
  }

  // Resuelve faltas pendientes y bloqueos vencidos antes de mostrar estados.
  const { error: evaluateError } = await auth.admin.rpc("evaluate_reservation_abuse")
  if (evaluateError) return databaseErrorResponse(evaluateError, ERROR_MESSAGE)

  const [statesResult, ipBlocksResult] = await Promise.all([
    auth.admin.from("reservation_abuse_states")
      .select("user_id, strike_count, last_strike_at, auto_blocked_at, auto_blocked_until, manual_block, manual_blocked_at, manual_blocked_until, manual_reason, updated_at")
      .order("updated_at", { ascending: false })
      .limit(200),
    auth.admin.from("reservation_ip_blocks").select("ip, reason, blocked_at").order("blocked_at", { ascending: false }),
  ])
  if (statesResult.error) return databaseErrorResponse(statesResult.error, ERROR_MESSAGE)
  if (ipBlocksResult.error) return databaseErrorResponse(ipBlocksResult.error, ERROR_MESSAGE)

  const states = (statesResult.data ?? []) as ReservationAbuseStateRow[]
  const userIds = states.map((state) => state.user_id)
  const [profilesResult, eventsResult, candidatesResult] = await Promise.all([
    userIds.length
      ? auth.admin.from("profiles").select("id, nombre, username, email").in("id", userIds)
      : Promise.resolve({ data: [], error: null }),
    userIds.length
      ? auth.admin.from("reservation_abuse_events")
          .select("user_id, event_type, created_at, client_ip")
          .in("user_id", userIds)
          .order("created_at", { ascending: false })
          .limit(2000)
      : Promise.resolve({ data: [], error: null }),
    userIds.length
      ? auth.admin.from("reservation_abuse_candidates").select("user_id, client_ip").in("user_id", userIds)
      : Promise.resolve({ data: [], error: null }),
  ])
  if (profilesResult.error) return databaseErrorResponse(profilesResult.error, ERROR_MESSAGE)
  if (eventsResult.error) return databaseErrorResponse(eventsResult.error, ERROR_MESSAGE)
  if (candidatesResult.error) return databaseErrorResponse(candidatesResult.error, ERROR_MESSAGE)

  const profiles = new Map((profilesResult.data ?? []).map((profile) => [profile.id, profile]))
  const lastEvent = new Map<string, { type: ReservationAbuseEventType; createdAt: string }>()
  const ips = new Map<string, Set<string>>()
  const addIp = (userId: string | null, ip: string | null) => {
    if (!userId || !ip) return
    const known = ips.get(userId) ?? new Set<string>()
    known.add(ip)
    ips.set(userId, known)
  }
  for (const event of eventsResult.data ?? []) {
    if (event.user_id && !lastEvent.has(event.user_id)) {
      lastEvent.set(event.user_id, { type: event.event_type as ReservationAbuseEventType, createdAt: event.created_at })
    }
    addIp(event.user_id, event.client_ip)
  }
  for (const candidate of candidatesResult.data ?? []) addIp(candidate.user_id, candidate.client_ip)

  const now = Date.now()
  const accounts: ReservationAbuseAccount[] = states.map((state) => {
    const profile = profiles.get(state.user_id)
    const effective = getReservationAbuseStatus(state, now)
    return {
      userId: state.user_id,
      name: profile?.nombre ?? null,
      username: profile?.username ?? null,
      email: profile?.email ?? null,
      strikes: effective.strikes,
      status: effective.status,
      blockedUntil: effective.blockedUntil,
      reason: effective.reason,
      lastEvent: lastEvent.get(state.user_id) ?? null,
      ips: [...(ips.get(state.user_id) ?? [])].slice(0, 5),
    }
  })
  const ipBlocks: ReservationIpBlock[] = (ipBlocksResult.data ?? []).map((block) => ({
    ip: block.ip,
    reason: block.reason,
    blockedAt: block.blocked_at,
  }))

  return Response.json({ accounts, ipBlocks })
}

export async function POST(request: Request) {
  const auth = await requireAdmin(request)
  if ("error" in auth) return auth.error

  const body = (await request.json().catch(() => null)) as {
    action?: unknown
    userId?: unknown
    ip?: unknown
    reason?: unknown
  } | null
  const reason = typeof body?.reason === "string" ? body.reason.trim().slice(0, 300) || null : null

  if (body?.action === "block_ip" || body?.action === "unblock_ip") {
    const ip = typeof body.ip === "string" ? body.ip.trim() : ""
    if (!isIP(ip)) return Response.json({ error: "Ingresá una IP válida." }, { status: 400 })
    const { error } = await auth.admin.rpc("admin_set_reservation_ip_block", {
      p_client_ip: ip,
      p_blocked: body.action === "block_ip",
      p_admin_id: auth.user.id,
      p_reason: reason,
    })
    return error ? databaseErrorResponse(error, ERROR_MESSAGE) : Response.json({ ok: true })
  }

  if (!isReservationBlockAction(body?.action)) {
    return Response.json({ error: "Acción inválida." }, { status: 400 })
  }
  const userId = typeof body.userId === "string" ? body.userId : ""
  if (!UUID_PATTERN.test(userId)) return Response.json({ error: "Cuenta inválida." }, { status: 400 })

  const { error } = await auth.admin.rpc("admin_set_reservation_block", {
    p_user_id: userId,
    p_action: body.action,
    p_admin_id: auth.user.id,
    p_reason: reason,
  })
  return error ? databaseErrorResponse(error, ERROR_MESSAGE) : Response.json({ ok: true })
}
