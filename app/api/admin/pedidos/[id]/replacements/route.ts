import { NextResponse } from "next/server"

import { requireAdmin } from "@/app/api/admin/clientes/_auth"

const DIFFERENT_PRODUCT_ERROR =
  "El reemplazo tiene que ser del mismo producto reclamado. Para otro producto, gestioná la devolución con Nota de Crédito / saldo a favor."

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(request)
  if ("error" in auth) return auth.error
  const orderId = Number((await params).id)
  if (!Number.isSafeInteger(orderId) || orderId <= 0) return NextResponse.json({ error: "Pedido inválido." }, { status: 400 })
  const [history, items] = await Promise.all([
    auth.admin.from("order_replacements").select("id,original_order_id,original_order_item_id,claim_id,replacement_variant_id,quantity,reason,unit_cost,created_at,notes").eq("original_order_id", orderId).order("created_at", { ascending: false }),
    auth.admin.from("orden_items").select("producto_id").eq("orden_id", orderId),
  ])
  if (history.error || items.error) return NextResponse.json({ error: "No se pudieron cargar los reemplazos. Reintentá." }, { status: 500 })
  // Un reemplazo es siempre del mismo producto reclamado: sólo se ofrecen las
  // variantes activas de los productos de este pedido (sin buscador global).
  const productIds = [...new Set(items.data.map((row) => Number(row.producto_id)).filter((id) => Number.isSafeInteger(id) && id > 0))]
  if (productIds.length === 0) return NextResponse.json({ replacements: history.data, variants: [] })
  const variants = await auth.admin.from("producto_variantes").select("id,producto_id,nombre,sku,stock,productos!inner(nombre,activo)")
    .in("producto_id", productIds).eq("activo", true).eq("productos.activo", true).order("nombre").limit(500)
  if (variants.error) return NextResponse.json({ error: "No se pudieron cargar los reemplazos. Reintentá." }, { status: 500 })
  return NextResponse.json({ replacements: history.data, variants: variants.data })
}

// Auditoría 4/7 (Fase 3, punto 6): flujo mínimo de cambio/reemplazo, ver
// supabase/migrations/20260920140000_order_replacements.sql. Server-side,
// idempotente, deja trazabilidad completa (order_replacements +
// order_audit_events) en vez de depender de chat/manual.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(request)
  if ("error" in auth) return auth.error

  const { id } = await params
  const orderId = Number(id)
  const body = (await request.json().catch(() => null)) as {
    orderItemId?: unknown
    replacementVariantId?: unknown
    quantity?: unknown
    reason?: unknown
    conditionNote?: unknown
    notes?: unknown
    claimId?: unknown
    idempotencyKey?: unknown
  } | null

  const orderItemId = Number(body?.orderItemId)
  const replacementVariantId = Number(body?.replacementVariantId)
  const quantity = Number(body?.quantity)
  const reason = body?.reason
  const idempotencyKey =
    typeof body?.idempotencyKey === "string" && /^[A-Za-z0-9._:-]{8,240}$/.test(body.idempotencyKey)
      ? body.idempotencyKey
      : null
  const claimIdValue = Number(body?.claimId)
  const claimId = Number.isInteger(claimIdValue) && claimIdValue > 0 ? claimIdValue : null

  if (
    !Number.isInteger(orderId) || orderId <= 0 ||
    !Number.isInteger(orderItemId) || orderItemId <= 0 ||
    !Number.isInteger(replacementVariantId) || replacementVariantId <= 0 ||
    !Number.isInteger(quantity) || quantity <= 0 ||
    typeof reason !== "string" ||
    !["mismo_producto", "otra_variante", "otro_producto", "garantia"].includes(reason)
  ) {
    return NextResponse.json({ error: "Revisá los datos del reemplazo." }, { status: 400 })
  }
  if (!idempotencyKey) {
    return NextResponse.json(
      { error: "La operación no tiene una clave de idempotencia válida." },
      { status: 400 },
    )
  }
  if (reason === "otro_producto") {
    return NextResponse.json({ error: DIFFERENT_PRODUCT_ERROR }, { status: 400 })
  }

  // Regla "mismo producto" server-side: la variante enviada tiene que ser del
  // producto del ítem original. La RPC sólo la ejecuta service_role y esta ruta
  // es su único llamador, así que el control vale para todo alta de reemplazo.
  const [originalItem, replacementVariant] = await Promise.all([
    auth.admin.from("orden_items").select("producto_id").eq("id", orderItemId).eq("orden_id", orderId).maybeSingle(),
    auth.admin.from("producto_variantes").select("producto_id").eq("id", replacementVariantId).maybeSingle(),
  ])
  if (originalItem.error || replacementVariant.error) {
    return NextResponse.json({ error: "No se pudo verificar el reemplazo. Reintentá." }, { status: 500 })
  }
  if (!originalItem.data) {
    return NextResponse.json({ error: "No se encontró el producto dentro del pedido original." }, { status: 400 })
  }
  if (!replacementVariant.data || Number(replacementVariant.data.producto_id) !== Number(originalItem.data.producto_id)) {
    return NextResponse.json({ error: DIFFERENT_PRODUCT_ERROR }, { status: 400 })
  }

  const { data, error } = await auth.admin.rpc("create_order_replacement", {
    p_original_order_id: orderId,
    p_original_order_item_id: orderItemId,
    p_replacement_variant_id: replacementVariantId,
    p_quantity: quantity,
    p_reason: reason,
    p_actor_id: auth.user.id,
    p_idempotency_key: idempotencyKey,
    p_condition_note: typeof body?.conditionNote === "string" ? body.conditionNote.slice(0, 500) : null,
    p_notes: typeof body?.notes === "string" ? body.notes.slice(0, 1000) : null,
    p_claim_id: claimId,
  })

  if (error || !data) {
    const message = error?.message ?? ""
    const requiresReceivedItem = /REPLACEMENT_REQUIRES_RECEIVED_ITEM/.test(message)
    const insufficientStock = /STOCK_INSUFICIENTE/.test(message)
    const forbidden = /REPLACEMENT_FORBIDDEN/.test(message)
    const conflict = /REPLACEMENT_CONFLICT|REPLACEMENT_QUANTITY_EXCEEDED|REPLACEMENT_UNAVAILABLE/.test(message)
    return NextResponse.json(
      {
        error: conflict ? "El pedido o el stock cambió. Recargá los datos y revisá las unidades ya reemplazadas antes de continuar." : requiresReceivedItem
          ? "Primero registrá la recepción física del producto original antes de generar el reemplazo."
          : insufficientStock
            ? "No hay stock suficiente del producto/variante de reemplazo."
            : forbidden
              ? "No tenés permisos para registrar este reemplazo."
              : "No se pudo registrar el reemplazo.",
      },
      { status: conflict || requiresReceivedItem || insufficientStock ? 409 : forbidden ? 403 : 500 },
    )
  }

  return NextResponse.json({ replacement: data })
}
