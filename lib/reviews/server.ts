import type { SupabaseClient, User } from "@supabase/supabase-js"

import { parseDeliveryAddress } from "@/lib/delivery-address"
import {
  getReviewWindow,
  REVIEW_WINDOW_MESSAGES,
  type ReviewWindow,
} from "@/lib/reviews/review-window"

const PAID_STATES = new Set(["pagado", "enviado", "entregado"])
const PRIVATE_DATA_PATTERN =
  /@|\b\d{6,}\b|\b(calle|avenida|av\.?|piso|depto|departamento|casa|altura|cp)\b/i
const ORDER_REVIEW_COLUMNS =
  "id, localidad, provincia, estado, payment_status, delivered_at, created_at"

type AdminClient = SupabaseClient

type OrderRow = {
  id: number
  localidad: string | null
  provincia: string | null
  estado: string
  payment_status: string | null
  delivered_at: string | null
  created_at: string
}

type ProfileRow = {
  username: string | null
  direccion: string | null
  codigo_postal: string | null
  provincia: string | null
}

export type EligibleReview = {
  orderId: number
  nickname: string
  city: string
  province: string
}

export type ReviewEligibility =
  | { ok: true; review: EligibleReview }
  | { ok: false; error: string }

export type PublicReview = {
  id: number
  rating: number
  comment: string
  nickname: string
  city: string
  province: string
  createdAt: string
  canDelete: boolean
}

const NOT_ELIGIBLE_ERROR = "No encontramos una compra verificada disponible para reseñar."

function safeNickname(value: unknown) {
  const nickname = String(value ?? "").trim()
  const looksLikeAddress = /\s\d{1,5}(?:\s|,|$)/.test(nickname)

  if (
    !nickname ||
    nickname.length > 24 ||
    PRIVATE_DATA_PATTERN.test(nickname) ||
    looksLikeAddress
  ) {
    return ""
  }

  return nickname
}

function safePlace(value: unknown) {
  const place = String(value ?? "").trim()

  if (
    !place ||
    place.length > 45 ||
    PRIVATE_DATA_PATTERN.test(place) ||
    /\d/.test(place)
  ) {
    return ""
  }

  return place
}

function isPaidOrder(order: OrderRow) {
  return (
    PAID_STATES.has(order.estado) ||
    order.payment_status === "approved"
  )
}

function getOrderWindowError(order: OrderRow) {
  if (!isPaidOrder(order)) return NOT_ELIGIBLE_ERROR

  const window = getReviewWindow(order)
  return window.status === "open" ? "" : REVIEW_WINDOW_MESSAGES[window.status]
}

function buildEligibleReview(
  order: OrderRow,
  profile: ProfileRow | null,
  user: User,
): ReviewEligibility {
  const parsedAddress = parseDeliveryAddress(
    profile?.direccion ?? "",
    order.provincia ?? profile?.provincia ?? undefined,
    profile?.codigo_postal ?? undefined,
  )
  const nickname = safeNickname(profile?.username ?? user.user_metadata?.username)
  const city = safePlace(order.localidad ?? parsedAddress.locality)
  const province = safePlace(order.provincia ?? profile?.provincia)

  if (!nickname || !city || !province) return { ok: false, error: NOT_ELIGIBLE_ERROR }

  return { ok: true, review: { orderId: order.id, nickname, city, province } }
}

export async function getEligibleReview(
  admin: AdminClient,
  user: User,
  orderId?: number,
): Promise<ReviewEligibility> {
  const requestedOrderId = Number(orderId)
  const hasRequestedOrder =
    Number.isInteger(requestedOrderId) && requestedOrderId > 0

  const ordersQuery = admin
    .from("ordenes")
    .select(ORDER_REVIEW_COLUMNS)
    .eq("usuario_id", user.id)

  const [reviewsResult, profileResult, ordersResult] = await Promise.all([
    admin
      .from("reviews")
      .select("order_id")
      .eq("user_id", user.id)
      .is("product_id", null),
    admin
      .from("profiles")
      .select("username, direccion, codigo_postal, provincia")
      .eq("id", user.id)
      .maybeSingle(),
    hasRequestedOrder
      ? ordersQuery.eq("id", requestedOrderId)
      : ordersQuery.order("created_at", { ascending: false }),
  ])

  if (reviewsResult.error) throw reviewsResult.error
  if (profileResult.error) throw profileResult.error
  if (ordersResult.error) throw ordersResult.error

  const reviewedOrderIds = new Set(
    (reviewsResult.data ?? []).map((review) => Number(review.order_id))
  )
  const orders = (ordersResult.data ?? []) as OrderRow[]
  const pendingOrders = orders.filter((candidate) => !reviewedOrderIds.has(candidate.id))

  if (hasRequestedOrder && orders.length > 0 && pendingOrders.length === 0) {
    return { ok: false, error: "Esta compra ya tiene una reseña." }
  }

  const order = pendingOrders.find((candidate) => !getOrderWindowError(candidate))

  if (!order) {
    const requestedOrder = hasRequestedOrder ? pendingOrders[0] : undefined
    return {
      ok: false,
      error: requestedOrder ? getOrderWindowError(requestedOrder) : NOT_ELIGIBLE_ERROR,
    }
  }

  return buildEligibleReview(order, profileResult.data as ProfileRow | null, user)
}

export async function getEligibleProductReview(
  admin: AdminClient,
  user: User,
  orderId: number,
  productId: number,
): Promise<ReviewEligibility> {
  const [orderResult, profileResult, reviewResult] = await Promise.all([
    admin
      .from("ordenes")
      .select(`${ORDER_REVIEW_COLUMNS}, orden_items(producto_id)`)
      .eq("id", orderId)
      .eq("usuario_id", user.id)
      .maybeSingle(),
    admin
      .from("profiles")
      .select("username, direccion, codigo_postal, provincia")
      .eq("id", user.id)
      .maybeSingle(),
    admin
      .from("reviews")
      .select("id")
      .eq("user_id", user.id)
      .eq("order_id", orderId)
      .eq("product_id", productId)
      .maybeSingle(),
  ])

  if (orderResult.error) throw orderResult.error
  if (profileResult.error) throw profileResult.error
  if (reviewResult.error) throw reviewResult.error
  if (!orderResult.data) return { ok: false, error: NOT_ELIGIBLE_ERROR }
  if (reviewResult.data) return { ok: false, error: "Este producto ya tiene una reseña." }

  const order = orderResult.data as OrderRow & {
    orden_items?: Array<{ producto_id: number }>
  }
  if (!(order.orden_items ?? []).some((item) => Number(item.producto_id) === productId)) {
    return { ok: false, error: NOT_ELIGIBLE_ERROR }
  }

  const windowError = getOrderWindowError(order)
  if (windowError) return { ok: false, error: windowError }

  return buildEligibleReview(order, profileResult.data as ProfileRow | null, user)
}

/** Estado del plazo de reseña de un pedido propio (null si no es del usuario). */
export async function getOwnOrderReviewWindow(
  admin: AdminClient,
  userId: string,
  orderId: number,
): Promise<ReviewWindow | null> {
  const { data, error } = await admin
    .from("ordenes")
    .select("estado, delivered_at")
    .eq("id", orderId)
    .eq("usuario_id", userId)
    .maybeSingle()

  if (error) throw error
  return data ? getReviewWindow(data) : null
}

export function toPublicReview(
  row: Record<string, unknown>,
  canDelete = false
): PublicReview {
  return {
    id: Number(row.id),
    rating: Number(row.rating),
    comment: String(row.comment),
    nickname: String(row.nickname),
    city: String(row.city),
    province: String(row.province),
    createdAt: String(row.created_at),
    canDelete,
  }
}
