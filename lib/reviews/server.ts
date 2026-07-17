import type { SupabaseClient, User } from "@supabase/supabase-js"

import { parseDeliveryAddress } from "@/lib/delivery-address"
import { validatePublicText } from "@/lib/validation/content-filter"

const PAID_STATES = new Set(["pagado", "enviado", "entregado"])
const PRIVATE_DATA_PATTERN =
  /@|\b\d{6,}\b|\b(calle|avenida|av\.?|piso|depto|departamento|casa|altura|cp)\b/i

type AdminClient = SupabaseClient

type OrderRow = {
  id: number
  localidad: string | null
  provincia: string | null
  estado: string
  payment_status: string | null
  created_at: string
}

export type EligibleReview = {
  orderId: number
  nickname: string
  city: string
  province: string
}

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

export function validateReviewComment(value: unknown) {
  const comment = String(value ?? "").trim()

  if (comment.length > 150) {
    return {
      error: "La reseña puede tener hasta 150 caracteres.",
      comment: "",
    }
  }

  if (!comment) {
    return { error: "", comment: "" }
  }

  const moderationError = validatePublicText(comment)

  if (moderationError) {
    return { error: moderationError, comment: "" }
  }

  if (PRIVATE_DATA_PATTERN.test(comment)) {
    return {
      error: "No incluyas emails, teléfonos ni direcciones en la reseña.",
      comment: "",
    }
  }

  return { error: "", comment }
}

export async function getEligibleReview(
  admin: AdminClient,
  user: User,
  orderId?: number,
): Promise<EligibleReview | null> {
  const requestedOrderId = Number(orderId)
  const hasRequestedOrder =
    Number.isInteger(requestedOrderId) && requestedOrderId > 0

  const [reviewsResult, profileResult] = await Promise.all([
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
  ])

  if (reviewsResult.error) throw reviewsResult.error
  if (profileResult.error) throw profileResult.error

  let orders: OrderRow[] = []

  if (hasRequestedOrder) {
    const orderResult = await admin
      .from("ordenes")
      .select("id, localidad, provincia, estado, payment_status, created_at")
      .eq("usuario_id", user.id)
      .eq("id", requestedOrderId)
      .maybeSingle()

    if (orderResult.error) throw orderResult.error
    orders = orderResult.data ? [orderResult.data as OrderRow] : []
  } else {
    const orderListResult = await admin
      .from("ordenes")
      .select("id, localidad, provincia, estado, payment_status, created_at")
      .eq("usuario_id", user.id)
      .order("created_at", { ascending: false })

    if (orderListResult.error) throw orderListResult.error
    orders = (orderListResult.data ?? []) as OrderRow[]
  }

  const reviewedOrderIds = new Set(
    (reviewsResult.data ?? []).map((review) => Number(review.order_id))
  )
  const order = orders.find(
    (candidate) => isPaidOrder(candidate) && !reviewedOrderIds.has(candidate.id)
  )

  if (!order) return null

  const profile = profileResult.data
  const parsedAddress = parseDeliveryAddress(
    profile?.direccion ?? "",
    order.provincia ?? profile?.provincia ?? undefined,
    profile?.codigo_postal ?? undefined
  )
  const nickname = safeNickname(
    profile?.username ?? user.user_metadata?.username
  )
  const city = safePlace(order.localidad ?? parsedAddress.locality)
  const province = safePlace(order.provincia ?? profile?.provincia)

  if (!nickname || !city || !province) return null

  return {
    orderId: order.id,
    nickname,
    city,
    province,
  }
}

export async function getEligibleProductReview(
  admin: AdminClient,
  user: User,
  orderId: number,
  productId: number,
): Promise<EligibleReview | null> {
  const [orderResult, profileResult, reviewResult] = await Promise.all([
    admin
      .from("ordenes")
      .select("id, usuario_id, localidad, provincia, estado, payment_status, orden_items(producto_id)")
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
  if (!orderResult.data || reviewResult.data) return null

  const order = orderResult.data as unknown as OrderRow & {
    usuario_id: string
    orden_items?: Array<{ producto_id: number }>
  }
  if (!isPaidOrder(order)) return null
  if (!(order.orden_items ?? []).some((item) => Number(item.producto_id) === productId)) return null

  const profile = profileResult.data
  const parsedAddress = parseDeliveryAddress(
    profile?.direccion ?? "",
    order.provincia ?? profile?.provincia ?? undefined,
    profile?.codigo_postal ?? undefined,
  )
  const nickname = safeNickname(profile?.username ?? user.user_metadata?.username)
  const city = safePlace(order.localidad ?? parsedAddress.locality)
  const province = safePlace(order.provincia ?? profile?.provincia)

  if (!nickname || !city || !province) return null
  return { orderId, nickname, city, province }
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
