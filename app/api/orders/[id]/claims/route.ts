import { NextResponse } from "next/server"

import { ORDER_CLAIM_MAX_FILES, CLAIM_TEXT_MAX_LENGTH, POST_DELIVERY_CLAIM_REASONS, getClaimEligibilityError } from "@/lib/order-claims"
import { isCustomerOrderOwner } from "@/lib/orders/customer-order-ownership"
import { claimErrorResponse, prepareClaimUploads, signClaims, submitCustomerClaim } from "@/lib/orders/claim-server"
import { createAdminClient } from "@/lib/supabase/admin"
import { createClient } from "@/lib/supabase/server"
import type { PostDeliveryClaimReason } from "@/lib/order-claims"
import type { SupabaseOrderClaim } from "@/lib/supabase/types"

export const maxDuration = 300

async function authorizeOrder(rawId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { response: NextResponse.json({ error: "Debés iniciar sesión." }, { status: 401 }) }
  const orderId = Number(rawId)
  if (!Number.isSafeInteger(orderId) || orderId <= 0) return { response: claimErrorResponse(new Error("CLAIM_INVALID")) }
  const admin = createAdminClient()
  const { data: order, error } = await admin.from("ordenes").select("id, usuario_id, cliente_email, estado, delivered_at").eq("id", orderId).maybeSingle()
  if (error || !order) return { response: NextResponse.json({ error: "No encontramos el pedido." }, { status: 404 }) }
  if (!isCustomerOrderOwner(order, user) || !order.usuario_id && !user.email_confirmed_at) return { response: claimErrorResponse(new Error("CLAIM_FORBIDDEN")) }
  return { admin, order, user }
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await authorizeOrder((await params).id)
    if ("response" in auth) return auth.response
    const { data, error } = await auth.admin.from("order_claims").select("*, order_claim_files(*), order_claim_messages(*)").eq("order_id", auth.order.id).order("created_at", { ascending: false })
    if (error) return claimErrorResponse(error)
    return NextResponse.json({ claims: await signClaims(auth.admin, data as SupabaseOrderClaim[]) })
  } catch (error) { return claimErrorResponse(error) }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await authorizeOrder((await params).id)
    if ("response" in auth) return auth.response
    // Límite previo al parseo cuando el transporte proporciona Content-Length.
    const bodySize = Number(request.headers.get("content-length") ?? 0)
    if (bodySize > ORDER_CLAIM_MAX_FILES * 40 * 1024 * 1024 + 65536) return NextResponse.json({ error: "Los archivos superan el tamaño permitido." }, { status: 413 })
    const form = await request.formData()
    const files = form.getAll("files")
    if (files.length > ORDER_CLAIM_MAX_FILES || files.some((file) => !(file instanceof File))) return claimErrorResponse(new Error("CLAIM_INVALID"))
    const allowedFields = new Set(["files","fileRoles","claimId","description","message","claimType","problemType","affectedItemIds","affectedWholeOrder","affectedItems","expectedUpdatedAt","refundAccountHolder","refundAccountIdentifier","refundBank","refundAmountConfirmed"])
    if ([...form.keys()].some((key) => !allowedFields.has(key))) return claimErrorResponse(new Error("CLAIM_INVALID"))
    const roles = form.getAll("fileRoles").map(String)
    if (roles.some((role) => !["evidencia_inicial","evidencia_adicional"].includes(role))) return claimErrorResponse(new Error("CLAIM_INVALID"))
    const claimId = form.has("claimId") ? Number(form.get("claimId")) : null
    const description = String(form.get("description") ?? "").trim()
    const message = String(form.get("message") ?? "").trim()
    if (description.length > CLAIM_TEXT_MAX_LENGTH || message.length > CLAIM_TEXT_MAX_LENGTH) return claimErrorResponse(new Error("CLAIM_INVALID"))
    let payload: Record<string, unknown>
    if (claimId !== null) {
      if (!Number.isSafeInteger(claimId) || claimId <= 0) return claimErrorResponse(new Error("CLAIM_INVALID"))
      const { data: claim } = await auth.admin.from("order_claims").select("id,user_id").eq("id", claimId).eq("order_id", auth.order.id).eq("user_id", auth.user.id).maybeSingle()
      if (!claim) return claimErrorResponse(new Error("CLAIM_FORBIDDEN"))
      const expectedUpdatedAt = String(form.get("expectedUpdatedAt") ?? "")
      if (!Number.isFinite(Date.parse(expectedUpdatedAt))) return claimErrorResponse(new Error("CLAIM_CONFLICT"))
      payload = { claimId, message, expectedUpdatedAt }
      if (form.has("refundAccountHolder")) {
        const refundDetails = {
          holder: String(form.get("refundAccountHolder") ?? "").trim(),
          identifier: String(form.get("refundAccountIdentifier") ?? "").trim(),
          bank: String(form.get("refundBank") ?? "").trim(),
          amount: String(form.get("refundAmountConfirmed") ?? "").trim(),
        }
        if (files.length || Object.values(refundDetails).some((value) => !value || value.length > 180)) return claimErrorResponse(new Error("CLAIM_INVALID"))
        payload.refundDetails = refundDetails
      }
    } else {
      const problemType = String(form.get("problemType") ?? "")
      const help = problemType === "consulta_pedido"
      if (!help && !POST_DELIVERY_CLAIM_REASONS.includes(problemType as PostDeliveryClaimReason)) return claimErrorResponse(new Error("CLAIM_INVALID"))
      if (!help) {
        const error = getClaimEligibilityError(auth.order, problemType as PostDeliveryClaimReason)
        if (error) return NextResponse.json({ error }, { status: 409 })
      }
      let items: Array<{ order_item_id: number; quantity: number }> = []
      if (!help) {
        const { data: orderItems, error } = await auth.admin.from("orden_items").select("id,cantidad").eq("orden_id", auth.order.id)
        if (error || !orderItems?.length) return claimErrorResponse(error ?? new Error("CLAIM_INVALID_ITEMS"))
        const wholeOrder = form.get("affectedWholeOrder") === "true"
        if (wholeOrder) {
          items = orderItems.map((item) => ({ order_item_id: Number(item.id), quantity: Number(item.cantidad) }))
        } else if (form.has("affectedItems")) {
          const requested: unknown = JSON.parse(String(form.get("affectedItems")))
          if (!Array.isArray(requested) || requested.length === 0 || requested.some((item) => !item || typeof item !== "object")) return claimErrorResponse(new Error("CLAIM_INVALID_ITEMS"))
          items = requested.map((item: { order_item_id?: unknown; quantity?: unknown }) => ({ order_item_id: Number(item.order_item_id), quantity: Number(item.quantity) }))
        } else {
          const ids = String(form.get("affectedItemIds") ?? "").split(",").map(Number)
          items = ids.map((id) => ({ order_item_id: id, quantity: Number(orderItems.find((item) => item.id === id)?.cantidad ?? 0) }))
        }
        if (new Set(items.map((item) => item.order_item_id)).size !== items.length ||
          items.some((item) => !Number.isSafeInteger(item.order_item_id) || !Number.isSafeInteger(item.quantity) || item.quantity <= 0 ||
            !orderItems.some((orderItem) => orderItem.id === item.order_item_id && item.quantity <= orderItem.cantidad))) return claimErrorResponse(new Error("CLAIM_INVALID_ITEMS"))
      }
      payload = { problemType, message: description, items }
    }
    const uploads = await prepareClaimUploads(files as File[])
    return await submitCustomerClaim(auth.admin, auth.user.id, auth.order.id, payload, uploads)
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) return claimErrorResponse(new Error("CLAIM_INVALID"))
    return claimErrorResponse(error)
  }
}

export async function PATCH() {
  return NextResponse.json({ error: "BEYONIX definirá la resolución del caso desde el panel administrativo." }, { status: 410 })
}
