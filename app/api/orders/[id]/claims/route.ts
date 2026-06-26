import { NextResponse } from "next/server"

import {
  ACTIVE_ORDER_CLAIM_STATUSES,
  CUSTOMER_SELECTABLE_ORDER_CLAIM_RESOLUTIONS,
  ORDER_CLAIM_BUCKET,
  getClaimFileValidationError,
  isClaimWindowOpen,
  sanitizeClaimFileName,
} from "@/lib/order-claims"
import { createAdminClient } from "@/lib/supabase/admin"
import { createClient } from "@/lib/supabase/server"
import type { OrderClaimType } from "@/lib/supabase/types"

const REPLACEMENT_ITEMS_PREFIX = "__replacement_items__:"
const CLAIM_TYPES = ["transporte_48hs", "garantia_beyonix"]
const POST_DISPATCH_PROBLEM_TYPES = ["danado", "incorrecto", "falla", "devolucion", "no_llego", "otro"]
const PRE_DISPATCH_PROBLEM_TYPES = ["cambio_producto", "cambio_color", "cambio_cantidad", "modificar_envio", "cancelar_compra", "otro_pre_despacho"]
const PROBLEM_TYPES = [...POST_DISPATCH_PROBLEM_TYPES, ...PRE_DISPATCH_PROBLEM_TYPES]

function isOrderDispatched(order: {
  estado?: string | null
  tracking_number?: string | null
  andreani_tracking?: string | null
  andreani_envio_id?: string | null
  andreani_estado?: string | null
}) {
  const estado = (order.estado ?? "").toLowerCase()
  const andreaniStatus = (order.andreani_estado ?? "").toLowerCase()

  return (
    ["enviado", "en_camino", "entregado"].includes(estado) ||
    Boolean(order.tracking_number || order.andreani_tracking || order.andreani_envio_id) ||
    ["camino", "tránsito", "transito", "distribución", "distribucion", "reparto", "visita", "entregado"].some(
      (status) => andreaniStatus.includes(status),
    )
  )
}

function isPaidOrder(order: { estado?: string | null; payment_status?: string | null }) {
  const paymentStatus = (order.payment_status ?? "").toLowerCase()
  return ["confirmed", "confirmado"].includes(paymentStatus)
}

function isOrderInvoiced(order: { invoice_status?: string | null; invoice_cae?: string | null }) {
  return order.invoice_status === "authorized" || Boolean(order.invoice_cae)
}

function stripBucket(path: string) {
  return path.startsWith(`${ORDER_CLAIM_BUCKET}/`)
    ? path.slice(ORDER_CLAIM_BUCKET.length + 1)
    : path
}

function normalizeStoredPath(path: string) {
  return path.startsWith(`${ORDER_CLAIM_BUCKET}/`)
    ? path
    : `${ORDER_CLAIM_BUCKET}/${path}`
}

function getDeliveryDate(order: { delivered_at?: string | null; created_at: string }) {
  return order.delivered_at || order.created_at
}

function parseReplacementItems(value: FormDataEntryValue | null) {
  if (typeof value !== "string" || !value.trim()) return []

  try {
    const parsed = JSON.parse(value)
    if (!Array.isArray(parsed)) return []

    return parsed
      .map((item) => ({
        productId: Number(item.productId),
        variantId: item.variantId ? Number(item.variantId) : null,
        quantity: Math.max(1, Math.min(99, Number(item.quantity ?? 1) || 1)),
        productName: String(item.productName ?? "").slice(0, 240),
        variantName: item.variantName ? String(item.variantName).slice(0, 160) : null,
        unitPrice: Number(item.unitPrice ?? 0) || 0,
        subtotal: Number(item.subtotal ?? 0) || 0,
        image: item.image ? String(item.image).slice(0, 700) : null,
      }))
      .filter((item) => Number.isFinite(item.productId) && item.productId > 0)
  } catch {
    return []
  }
}

async function attachSignedUrls(
  admin: ReturnType<typeof createAdminClient>,
  claims: any[],
) {
  return Promise.all(
    claims.map(async (claim) => ({
      ...claim,
      order_claim_files: await Promise.all(
        (claim.order_claim_files ?? []).map(async (file: any) => {
          const { data } = await admin.storage
            .from(ORDER_CLAIM_BUCKET)
            .createSignedUrl(stripBucket(file.file_path), 300)

          return {
            ...file,
            signedUrl: data?.signedUrl ?? null,
          }
        }),
      ),
    })),
  )
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: "Debés iniciar sesión." }, { status: 401 })
  }

  const { id } = await params
  const orderId = Number(id)

  if (!Number.isFinite(orderId) || orderId <= 0) {
    return NextResponse.json({ error: "Pedido inválido." }, { status: 400 })
  }

  const admin = createAdminClient()
  const { data: order, error: orderError } = await admin
    .from("ordenes")
    .select("id, usuario_id")
    .eq("id", orderId)
    .maybeSingle()

  if (orderError || !order) {
    return NextResponse.json({ error: "No encontramos el pedido." }, { status: 404 })
  }

  if (order.usuario_id !== user.id) {
    return NextResponse.json({ error: "No autorizado." }, { status: 403 })
  }

  const { data: claims, error } = await admin
    .from("order_claims")
    .select("*, order_claim_files(*), order_claim_messages(*)")
    .eq("order_id", orderId)
    .order("created_at", { ascending: false })

  if (error) {
    return NextResponse.json(
      { error: "No se pudieron cargar los reclamos." },
      { status: 500 },
    )
  }

  return NextResponse.json({ claims: await attachSignedUrls(admin, claims ?? []) })
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: "Debés iniciar sesión." }, { status: 401 })
  }

  const { id } = await params
  const orderId = Number(id)

  if (!Number.isFinite(orderId) || orderId <= 0) {
    return NextResponse.json({ error: "Pedido inválido." }, { status: 400 })
  }

  const formData = await request.formData()
  const admin = createAdminClient()
  const { data: order, error: orderError } = await admin
    .from("ordenes")
    .select("id, usuario_id, estado, payment_status, delivered_at, created_at, tracking_number, andreani_tracking, andreani_envio_id, andreani_estado, invoice_status, invoice_cae, order_change_used")
    .eq("id", orderId)
    .maybeSingle()

  if (orderError || !order) {
    return NextResponse.json({ error: "No encontramos el pedido." }, { status: 404 })
  }

  if (order.usuario_id !== user.id) {
    return NextResponse.json({ error: "No autorizado." }, { status: 403 })
  }

  const currentProblemType = String(formData.get("problemType") ?? "").trim()
  const dispatched = isOrderDispatched(order)
  const invoiced = isOrderInvoiced(order)
  const preDispatchClaim = !dispatched && !invoiced
  const preDispatchProblemRequested = currentProblemType ? PRE_DISPATCH_PROBLEM_TYPES.includes(currentProblemType) : false

  if (preDispatchProblemRequested && invoiced) {
    return NextResponse.json(
      { error: "No se puede modificar un pedido facturado." },
      { status: 409 },
    )
  }

  if (preDispatchProblemRequested && dispatched) {
    return NextResponse.json(
      { error: "No se puede modificar un pedido despachado." },
      { status: 409 },
    )
  }

  if (preDispatchClaim && currentProblemType && !PRE_DISPATCH_PROBLEM_TYPES.includes(currentProblemType)) {
    return NextResponse.json(
      { error: "Elegí una opción disponible para pedidos antes del despacho." },
      { status: 400 },
    )
  }

  if (!preDispatchClaim && currentProblemType && !POST_DISPATCH_PROBLEM_TYPES.includes(currentProblemType)) {
    return NextResponse.json(
      { error: "Elegí una opción disponible para pedidos despachados o entregados." },
      { status: 400 },
    )
  }

  const claimId = Number(formData.get("claimId"))
  const description = String(formData.get("description") ?? "").trim()
  const message = String(formData.get("message") ?? "").trim()
  const files = formData.getAll("files").filter((file): file is File => file instanceof File)
  const fileRoles = formData.getAll("fileRoles").map((role) => String(role))

  if (claimId) {
    const { data: claim, error: claimError } = await admin
      .from("order_claims")
      .select("*")
      .eq("id", claimId)
      .eq("order_id", orderId)
      .eq("user_id", user.id)
      .maybeSingle()

    if (claimError || !claim) {
      return NextResponse.json({ error: "No encontramos el reclamo." }, { status: 404 })
    }

    if (!ACTIVE_ORDER_CLAIM_STATUSES.includes(claim.status as any)) {
      return NextResponse.json(
        { error: "Este reclamo ya no admite respuestas." },
        { status: 409 },
      )
    }

    const refundAccountHolder = String(formData.get("refundAccountHolder") ?? "").trim()
    const refundAccountIdentifier = String(formData.get("refundAccountIdentifier") ?? "").trim()
    const refundBank = String(formData.get("refundBank") ?? "").trim()
    const refundAmountConfirmed = String(formData.get("refundAmountConfirmed") ?? "").trim()
    const isRefundDetailsSubmission =
      Boolean(refundAccountHolder || refundAccountIdentifier || refundBank || refundAmountConfirmed)
    const replacementProductId = Number(formData.get("replacementProductId"))
    const replacementVariantIdRaw = String(formData.get("replacementVariantId") ?? "").trim()
    const replacementVariantId = replacementVariantIdRaw ? Number(replacementVariantIdRaw) : null
    const replacementQuantity = Math.max(
      1,
      Math.min(99, Number(formData.get("replacementQuantity") ?? 1) || 1),
    )
    const replacementOriginalProduct = String(formData.get("replacementOriginalProduct") ?? "")
      .trim()
      .slice(0, 240)
    const replacementOriginalVariant = String(formData.get("replacementOriginalVariant") ?? "")
      .trim()
      .slice(0, 160)
    const replacementOriginalPrice = Number(formData.get("replacementOriginalPrice") ?? 0)
    const replacementOriginalOrderItemId = Number(formData.get("replacementOriginalOrderItemId"))
    const replacementChangeReason = String(formData.get("replacementChangeReason") ?? "")
      .trim()
      .slice(0, 600)
    const replacementItems = parseReplacementItems(formData.get("replacementItems"))
    const isReplacementSelectionSubmission =
      replacementItems.length > 0 || (Number.isFinite(replacementProductId) && replacementProductId > 0)
    const isDifferenceProofSubmission =
      files.length > 0 &&
      fileRoles.length === files.length &&
      fileRoles.every((role) => role === "comprobante_diferencia")

    if (isDifferenceProofSubmission) {
      const priceDifference = Number(claim.replacement_price_difference ?? 0)
      if (priceDifference <= 0) {
        return NextResponse.json(
          { error: "Este cambio no requiere comprobante de diferencia." },
          { status: 400 },
        )
      }

      const { error: deleteError } = await admin
        .from("order_claim_files")
        .delete()
        .eq("claim_id", claim.id)
        .eq("file_role", "comprobante_diferencia")

      if (deleteError) {
        return NextResponse.json(
          { error: deleteError.message || "No se pudo reemplazar el comprobante anterior." },
          { status: 500 },
        )
      }

      await uploadFiles(admin, claim.id, user.id, files.slice(0, 1), ["comprobante_diferencia"])

      await admin
        .from("order_claims")
        .update({
          admin_needs_action: true,
          last_customer_message_at: new Date().toISOString(),
        })
        .eq("id", claim.id)

      return getClaimResponse(admin, claim.id)
    }

    if (claim.status === "reintegro_pendiente") {
      if (!isRefundDetailsSubmission) {
        return NextResponse.json(
          { error: "Completá los datos de reintegro para continuar." },
          { status: 409 },
        )
      }

      if (
        !refundAccountHolder ||
        !refundAccountIdentifier ||
        !refundBank ||
        !refundAmountConfirmed
      ) {
        return NextResponse.json(
          { error: "Completá todos los datos de reintegro." },
          { status: 400 },
        )
      }

      const now = new Date().toISOString()
      const { error: refundError } = await admin
        .from("order_claims")
        .update({
          refund_account_holder: refundAccountHolder.slice(0, 180),
          refund_account_identifier: refundAccountIdentifier.slice(0, 180),
          refund_bank: refundBank.slice(0, 180),
          refund_amount_confirmed: refundAmountConfirmed.slice(0, 80),
          refund_details_submitted_at: now,
          admin_needs_action: true,
          last_customer_message_at: now,
        })
        .eq("id", claim.id)

      if (refundError) {
        return NextResponse.json(
          { error: "No se pudieron guardar los datos de reintegro." },
          { status: 500 },
        )
      }

      await admin.from("order_claim_messages").insert({
        claim_id: claim.id,
        author_user_id: user.id,
        author_role: "cliente",
        message: "Datos de reintegro enviados. BEYONIX realizará el reintegro.",
      })

      return getClaimResponse(admin, claim.id)
    }

    if (claim.status === "cambio_pendiente" && isReplacementSelectionSubmission) {
      if (invoiced) {
        return NextResponse.json(
          { error: "No se puede modificar un pedido facturado." },
          { status: 409 },
        )
      }

      if (dispatched) {
        return NextResponse.json(
          { error: "No se puede modificar un pedido despachado." },
          { status: 409 },
        )
      }

      const originalProductMatch = claim.description.match(/^Producto afectado:\s*(.+?)(?:\r?\n){2}/)
      const { data: product, error: productError } = await admin
        .from("productos")
        .select("id, nombre, precio, activo, producto_variantes(*)")
        .eq("id", replacementProductId)
        .eq("activo", true)
        .maybeSingle()

      if (productError || !product) {
        return NextResponse.json(
          { error: "No encontramos el producto de reemplazo." },
          { status: 404 },
        )
      }

      let originalOrderItem: { id: number; producto_id: number | null } | null = null
      if (Number.isFinite(replacementOriginalOrderItemId) && replacementOriginalOrderItemId > 0) {
        const { data } = await admin
          .from("orden_items")
          .select("id, producto_id")
          .eq("id", replacementOriginalOrderItemId)
          .eq("orden_id", orderId)
          .maybeSingle()

        originalOrderItem = data

        if (!originalOrderItem) {
          return NextResponse.json(
            { error: "El producto original seleccionado no pertenece al pedido." },
            { status: 400 },
          )
        }
      }

      if (claim.failure_type === "cambio_color") {
        if (!originalOrderItem && claim.replacement_original_order_item_id) {
          const { data } = await admin
            .from("orden_items")
            .select("id, producto_id")
            .eq("id", claim.replacement_original_order_item_id)
            .eq("orden_id", orderId)
            .maybeSingle()

          originalOrderItem = data
        }

        if (originalOrderItem && Number(originalOrderItem.producto_id) !== Number(product.id)) {
          return NextResponse.json(
            { error: "Para cambiar color, elegí una variante del mismo producto." },
            { status: 400 },
          )
        }
      }

      const variants = product.producto_variantes ?? []
      const selectedVariant = replacementVariantId
        ? variants.find((variant: any) => Number(variant.id) === replacementVariantId)
        : null

      if (replacementVariantId && !selectedVariant) {
        return NextResponse.json(
          { error: "La variante seleccionada no está disponible." },
          { status: 400 },
        )
      }

      const availableStock = selectedVariant
        ? Number((selectedVariant as any).stock ?? 0)
        : Number((product as any).stock ?? 0)

      if (availableStock < replacementQuantity) {
        return NextResponse.json(
          { error: "No hay stock suficiente para el producto solicitado." },
          { status: 409 },
        )
      }

      const originalPrice = Number.isFinite(replacementOriginalPrice)
        ? replacementOriginalPrice
        : 0
      const requestedPrice = replacementItems.length > 0
        ? replacementItems.reduce((total, item) => total + Number(item.subtotal ?? 0), 0)
        : Number(product.precio ?? 0) * replacementQuantity
      const priceDifference = requestedPrice - originalPrice
      const now = new Date().toISOString()
      const requestedProductsSummary = replacementItems.length > 0
        ? replacementItems
            .map((item) => `${item.productName || "Producto"}${item.variantName ? ` · ${item.variantName}` : ""} x${item.quantity}`)
            .join("; ")
        : String(product.nombre ?? "").slice(0, 240)
      const requestedVariantsSummary = replacementItems.length > 0
        ? replacementItems.map((item) => item.variantName).filter(Boolean).join("; ")
        : selectedVariant?.nombre ?? null
      const requestedQuantityTotal = replacementItems.length > 0
        ? replacementItems.reduce((total, item) => total + item.quantity, 0)
        : replacementQuantity

      const { error: replacementError } = await admin
        .from("order_claims")
        .update({
          replacement_original_product: replacementOriginalProduct || originalProductMatch?.[1]?.trim() || null,
          replacement_original_order_item_id:
            Number.isFinite(replacementOriginalOrderItemId) && replacementOriginalOrderItemId > 0
              ? replacementOriginalOrderItemId
              : null,
          replacement_original_variant: replacementOriginalVariant || null,
          replacement_original_price: originalPrice,
          replacement_requested_product_id: Number(product.id),
          replacement_requested_product: requestedProductsSummary.slice(0, 240),
          replacement_requested_variant_id: selectedVariant ? Number(selectedVariant.id) : null,
          replacement_requested_variant: requestedVariantsSummary || null,
          replacement_requested_quantity: requestedQuantityTotal,
          replacement_requested_stock: availableStock,
          replacement_requested_price: requestedPrice,
          replacement_price_difference: priceDifference,
          replacement_change_reason: replacementItems.length > 0
            ? `${REPLACEMENT_ITEMS_PREFIX}${JSON.stringify({ reason: replacementChangeReason || null, items: replacementItems })}`
            : replacementChangeReason || null,
          replacement_customer_selected_at: now,
          admin_needs_action: true,
          last_customer_message_at: now,
        })
        .eq("id", claim.id)

      if (replacementError) {
        return NextResponse.json(
          { error: "No se pudo guardar el producto de reemplazo." },
          { status: 500 },
        )
      }

      await admin
        .from("ordenes")
        .update({
          order_change_status: "change_requested",
          order_change_extra_amount: Math.max(priceDifference, 0),
        })
        .eq("id", orderId)

      return getClaimResponse(admin, claim.id)
    }

    const { data: latestMessage } = await admin
      .from("order_claim_messages")
      .select("author_role")
      .eq("claim_id", claim.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()

    if (latestMessage?.author_role === "cliente") {
      return NextResponse.json(
        { error: "Mensaje enviado. Esperá la respuesta de BEYONIX para continuar." },
        { status: 409 },
      )
    }

    if (message.length < 5 && files.length === 0) {
      return NextResponse.json(
        { error: "Agreg? una respuesta o nueva evidencia." },
        { status: 400 },
      )
    }

    if (files.length > 0 && claim.status !== "falta_informacion") {
      const { count } = await admin
        .from("order_claim_files")
        .select("id", { count: "exact", head: true })
        .eq("claim_id", claim.id)

      if ((count ?? 0) > 0) {
        return NextResponse.json(
          { error: "La evidencia ya fue enviada. Podrás adjuntar más archivos si BEYONIX solicita información adicional." },
          { status: 409 },
        )
      }
    }

    if (message.length >= 5) {
      await admin.from("order_claim_messages").insert({
        claim_id: claim.id,
        author_user_id: user.id,
        author_role: "cliente",
        message,
      })
    } else if (files.length > 0) {
      await admin.from("order_claim_messages").insert({
        claim_id: claim.id,
        author_user_id: user.id,
        author_role: "cliente",
        message: "El cliente adjuntá nueva evidencia.",
      })
    }

    await uploadFiles(admin, claim.id, user.id, files, fileRoles)
    await admin
      .from("order_claims")
      .update({
        status: "en_revision",
        admin_needs_action: true,
        last_customer_message_at: new Date().toISOString(),
      })
      .eq("id", claim.id)

    return getClaimResponse(admin, claim.id)
  }

  const claimType = String(formData.get("claimType") ?? "") as OrderClaimType
  const failureType = String(formData.get("failureType") ?? "").trim()
  const problemType = String(formData.get("problemType") ?? "").trim()
  const startedAt = String(formData.get("startedAt") ?? "").trim()
  const affectedItemIds = String(formData.get("affectedItemIds") ?? "")
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item) && item > 0)
  const replacementOriginalOrderItemId =
    preDispatchClaim &&
    ["cambio_producto", "cambio_color", "cambio_cantidad"].includes(problemType) &&
    affectedItemIds.length === 1
      ? affectedItemIds[0]
      : null

  if (!CLAIM_TYPES.includes(claimType)) {
    return NextResponse.json({ error: "Tipo de reclamo inválido." }, { status: 400 })
  }

  if (preDispatchClaim && order.order_change_used) {
    return NextResponse.json(
      { error: "Ya usaste la corrección disponible para este pedido." },
      { status: 409 },
    )
  }

  if (
    !preDispatchClaim &&
    problemType !== "no_llego" &&
    !isClaimWindowOpen(getDeliveryDate(order), claimType)
  ) {
    return NextResponse.json(
      { error: "El plazo para este tipo de reclamo ya finaliz?." },
      { status: 409 },
    )
  }

  if (problemType && !PROBLEM_TYPES.includes(problemType)) {
    return NextResponse.json({ error: "Motivo de reclamo inválido." }, { status: 400 })
  }

  const immediateProductChange = preDispatchClaim && ["cambio_producto", "cambio_color"].includes(problemType)
  const replacementProductId = Number(formData.get("replacementProductId"))
  const replacementVariantIdRaw = String(formData.get("replacementVariantId") ?? "").trim()
  const replacementVariantId = replacementVariantIdRaw ? Number(replacementVariantIdRaw) : null
  const replacementQuantity = Math.max(
    1,
    Math.min(99, Number(formData.get("replacementQuantity") ?? 1) || 1),
  )
  const replacementOriginalProduct = String(formData.get("replacementOriginalProduct") ?? "")
    .trim()
    .slice(0, 240)
  const replacementOriginalVariant = String(formData.get("replacementOriginalVariant") ?? "")
    .trim()
    .slice(0, 160)
  const replacementOriginalPrice = Number(formData.get("replacementOriginalPrice") ?? 0)
  const replacementChangeReason = String(formData.get("replacementChangeReason") ?? "")
    .trim()
    .slice(0, 600)
  const replacementItems = parseReplacementItems(formData.get("replacementItems"))
  const hasInitialReplacementSelection =
    replacementItems.length > 0 || (Number.isFinite(replacementProductId) && replacementProductId > 0)
  const initialCustomerMessage = description
    .replace(/^Producto afectado:\s*.+?(?:\r?\n){2}/, "")
    .trim()

  if (problemType === "cambio_producto" && !hasInitialReplacementSelection) {
    return NextResponse.json(
      { error: "Elegí el producto solicitado." },
      { status: 400 },
    )
  }

  if (!preDispatchClaim && description.length < 10) {
    return NextResponse.json(
      { error: "Contanos un poco más para poder ayudarte." },
      { status: 400 },
    )
  }

  if (replacementOriginalOrderItemId) {
    const { data: originalItem } = await admin
      .from("orden_items")
      .select("id")
      .eq("id", replacementOriginalOrderItemId)
      .eq("orden_id", orderId)
      .maybeSingle()

    if (!originalItem) {
      return NextResponse.json(
        { error: "El producto original seleccionado no pertenece al pedido." },
        { status: 400 },
      )
    }
  }

  let initialReplacementData: Record<string, unknown> = {}
  let initialOrderChangeData: Record<string, unknown> | null = null

  if (hasInitialReplacementSelection) {
    if (invoiced) {
      return NextResponse.json(
        { error: "No se puede modificar un pedido facturado." },
        { status: 409 },
      )
    }

    if (dispatched) {
      return NextResponse.json(
        { error: "No se puede modificar un pedido despachado." },
        { status: 409 },
      )
    }

    const { data: product, error: productError } = await admin
      .from("productos")
      .select("id, nombre, precio, activo, producto_variantes(*)")
      .eq("id", replacementProductId)
      .eq("activo", true)
      .maybeSingle()

    if (productError || !product) {
      return NextResponse.json(
        { error: "No encontramos el producto solicitado." },
        { status: 404 },
      )
    }

    let originalOrderItem: { id: number; producto_id: number | null } | null = null
    if (replacementOriginalOrderItemId) {
      const { data } = await admin
        .from("orden_items")
        .select("id, producto_id")
        .eq("id", replacementOriginalOrderItemId)
        .eq("orden_id", orderId)
        .maybeSingle()

      originalOrderItem = data
    }

    if (problemType === "cambio_color" && originalOrderItem && Number(originalOrderItem.producto_id) !== Number(product.id)) {
      return NextResponse.json(
        { error: "Para cambiar color, elegí una variante del mismo producto." },
        { status: 400 },
      )
    }

    const variants = product.producto_variantes ?? []
    const selectedVariant = replacementVariantId
      ? variants.find((variant: any) => Number(variant.id) === replacementVariantId)
      : null

    if (replacementVariantId && !selectedVariant) {
      return NextResponse.json(
        { error: "La variante seleccionada no está disponible." },
        { status: 400 },
      )
    }

    const availableStock = selectedVariant
      ? Number((selectedVariant as any).stock ?? 0)
      : Number((product as any).stock ?? 0)

    if (availableStock < replacementQuantity) {
      return NextResponse.json(
        { error: "No hay stock suficiente para el producto solicitado." },
        { status: 409 },
      )
    }

    const originalPrice = Number.isFinite(replacementOriginalPrice)
      ? replacementOriginalPrice
      : 0
    const requestedPrice = replacementItems.length > 0
      ? replacementItems.reduce((total, item) => total + Number(item.subtotal ?? 0), 0)
      : Number(product.precio ?? 0) * replacementQuantity
    const priceDifference = requestedPrice - originalPrice
    const now = new Date().toISOString()
    const requestedProductsSummary = replacementItems.length > 0
      ? replacementItems
          .map((item) => `${item.productName || "Producto"}${item.variantName ? ` · ${item.variantName}` : ""} x${item.quantity}`)
          .join("; ")
      : String(product.nombre ?? "").slice(0, 240)
    const requestedVariantsSummary = replacementItems.length > 0
      ? replacementItems.map((item) => item.variantName).filter(Boolean).join("; ")
      : selectedVariant?.nombre ?? null
    const requestedQuantityTotal = replacementItems.length > 0
      ? replacementItems.reduce((total, item) => total + item.quantity, 0)
      : replacementQuantity

    initialReplacementData = {
      replacement_original_product: replacementOriginalProduct || null,
      replacement_original_order_item_id: replacementOriginalOrderItemId || null,
      replacement_original_variant: replacementOriginalVariant || null,
      replacement_original_price: originalPrice,
      replacement_requested_product_id: Number(product.id),
      replacement_requested_product: requestedProductsSummary.slice(0, 240),
      replacement_requested_variant_id: selectedVariant ? Number(selectedVariant.id) : null,
      replacement_requested_variant: requestedVariantsSummary || null,
      replacement_requested_quantity: requestedQuantityTotal,
      replacement_requested_stock: availableStock,
      replacement_requested_price: requestedPrice,
      replacement_price_difference: priceDifference,
      replacement_change_reason: replacementItems.length > 0
        ? `${REPLACEMENT_ITEMS_PREFIX}${JSON.stringify({ reason: replacementChangeReason || null, items: replacementItems })}`
        : replacementChangeReason || null,
      replacement_customer_selected_at: now,
    }
    initialOrderChangeData = {
      order_change_status: "change_requested",
      order_change_extra_amount: Math.max(priceDifference, 0),
    }
  }

  const activeClaimResult = await admin
    .from("order_claims")
    .select("id")
    .eq("order_id", orderId)
    .in("status", ACTIVE_ORDER_CLAIM_STATUSES)
    .maybeSingle()

  if (activeClaimResult.data) {
    return NextResponse.json(
      { error: "Ya existe un reclamo activo para este pedido." },
      { status: 409 },
    )
  }

  const { data: claim, error: claimError } = await admin
    .from("order_claims")
    .insert({
      order_id: orderId,
      user_id: user.id,
      claim_type: claimType,
      status: immediateProductChange ? "cambio_pendiente" : "recibido",
      failure_type: problemType || failureType || null,
      started_at: startedAt || null,
      description,
      replacement_original_order_item_id: replacementOriginalOrderItemId,
      ...initialReplacementData,
      customer_selected_resolution: immediateProductChange ? "cambio_producto" : null,
      resolution: immediateProductChange ? "cambio_producto" : null,
      offered_resolutions: immediateProductChange ? [] : null,
      admin_needs_action: hasInitialReplacementSelection || !immediateProductChange,
      last_customer_message_at: new Date().toISOString(),
    })
    .select()
    .single()

  if (claimError || !claim) {
    return NextResponse.json(
      { error: claimError?.message || "No se pudo crear el reclamo." },
      { status: 500 },
    )
  }

  if (initialCustomerMessage) {
    await admin.from("order_claim_messages").insert({
      claim_id: claim.id,
      author_user_id: user.id,
      author_role: "cliente",
      message: description,
    })
  }

  if (preDispatchClaim) {
    await admin
      .from("ordenes")
      .update({ order_change_used: true, ...(initialOrderChangeData ?? {}) })
      .eq("id", orderId)
  }

  await uploadFiles(admin, claim.id, user.id, files, fileRoles)
  return getClaimResponse(admin, claim.id)
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: "Debés iniciar sesión." }, { status: 401 })
  }

  const { id } = await params
  const orderId = Number(id)

  if (!Number.isFinite(orderId) || orderId <= 0) {
    return NextResponse.json({ error: "Pedido inválido." }, { status: 400 })
  }

  const body = (await request.json()) as {
    claimId?: unknown
    selectedResolution?: unknown
    decision?: unknown
  }
  const claimId = Number(body.claimId)
  const selectedResolution = String(body.selectedResolution ?? "")
  const decision = body.decision === "reject" ? "reject" : "accept"

  if (!Number.isFinite(claimId) || claimId <= 0) {
    return NextResponse.json({ error: "Reclamo inválido." }, { status: 400 })
  }

  if (
    decision === "accept" &&
    !CUSTOMER_SELECTABLE_ORDER_CLAIM_RESOLUTIONS.includes(
      selectedResolution as any,
    )
  ) {
    return NextResponse.json({ error: "Solución inválida." }, { status: 400 })
  }

  const admin = createAdminClient()
  const { data: claim, error: claimError } = await admin
    .from("order_claims")
    .select("*")
    .eq("id", claimId)
    .eq("order_id", orderId)
    .eq("user_id", user.id)
    .maybeSingle()

  if (claimError || !claim) {
    return NextResponse.json(
      { error: "No encontramos el reclamo." },
      { status: 404 },
    )
  }

  if (
    !["recibido", "en_revision", "falta_informacion", "aprobado"].includes(
      claim.status,
    )
  ) {
    return NextResponse.json(
      { error: "Este reclamo ya no admite selección de solución." },
      { status: 409 },
    )
  }

  if (
    decision === "accept" &&
    !(claim.offered_resolutions ?? []).includes(selectedResolution)
  ) {
    return NextResponse.json(
      { error: "Esta solución no está disponible para tu reclamo." },
      { status: 409 },
    )
  }

  const accepted = decision === "accept"
  const nextAcceptedStatus =
    selectedResolution === "reintegro_total" ||
    selectedResolution === "reintegro_parcial"
      ? "reintegro_pendiente"
      : selectedResolution === "cambio_producto"
        ? "cambio_pendiente"
        : selectedResolution === "cupon_descuento"
          ? "cupon_pendiente"
          : "en_revision"
  const adminNeedsAction =
    accepted &&
    ["reintegro_pendiente", "cambio_pendiente", "cupon_pendiente"].includes(
      nextAcceptedStatus,
    )
  const { error } = await admin
    .from("order_claims")
    .update({
      customer_selected_resolution: accepted ? selectedResolution : null,
      resolution: accepted ? selectedResolution : null,
      offered_resolutions: accepted ? claim.offered_resolutions ?? [] : [],
      status: accepted ? nextAcceptedStatus : "en_revision",
      closed_at: null,
      admin_needs_action: adminNeedsAction,
    })
    .eq("id", claim.id)

  if (error) {
    return NextResponse.json(
      { error: "No se pudo guardar la solución elegida." },
      { status: 500 },
    )
  }

  return getClaimResponse(admin, claim.id)
}

async function uploadFiles(
  admin: ReturnType<typeof createAdminClient>,
  claimId: number,
  userId: string,
  files: File[],
  fileRoles: string[],
) {
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index]
    const validationError = getClaimFileValidationError(file)

    if (validationError) throw new Error(validationError)

    const safeName = sanitizeClaimFileName(file.name)
    const path = `${claimId}/${Date.now()}-${index}-${safeName}`
    const { error } = await admin.storage.from(ORDER_CLAIM_BUCKET).upload(path, file, {
      contentType: file.type,
      upsert: false,
    })

    if (error) throw new Error(error.message || "No se pudo subir la evidencia.")

    const { error: insertError } = await admin.from("order_claim_files").insert({
      claim_id: claimId,
      uploaded_by: userId,
      file_role: fileRoles[index] || "evidencia_adicional",
      file_name: file.name,
      file_path: normalizeStoredPath(path),
      mime_type: file.type || "application/octet-stream",
      file_size: file.size,
    })

    if (insertError) throw new Error(insertError.message || "No se pudo guardar la evidencia.")
  }
}

async function getClaimResponse(
  admin: ReturnType<typeof createAdminClient>,
  claimId: number,
) {
  const { data: claims, error } = await admin
    .from("order_claims")
    .select("*, order_claim_files(*), order_claim_messages(*)")
    .eq("id", claimId)

  if (error || !claims?.[0]) {
    return NextResponse.json(
      { error: "No se pudo cargar el reclamo actualizado." },
      { status: 500 },
    )
  }

  const [claim] = await attachSignedUrls(admin, claims)
  return NextResponse.json({ claim })
}
