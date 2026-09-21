import { NextResponse } from "next/server"

import { requireAdmin } from "@/app/api/admin/clientes/_auth"

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(request)
  if ("error" in auth) return auth.error
  const orderId = Number((await params).id)
  if (!Number.isSafeInteger(orderId) || orderId <= 0) return NextResponse.json({ error: "Pedido inválido." }, { status: 400 })
  const search = new URL(request.url).searchParams.get("search")?.trim().slice(0, 120) || ""
  const [history, variants] = await Promise.all([
    auth.admin.from("order_replacements").select("id,original_order_item_id,replacement_variant_id,quantity,reason,unit_cost,created_at,notes").eq("original_order_id", orderId).order("created_at", { ascending: false }),
    auth.admin.from("producto_variantes").select("id,nombre,sku,stock,productos!inner(nombre,activo)").eq("activo", true).eq("productos.activo", true)
      .ilike("nombre", `%${search.replace(/[\\%_]/g, "\\$&")}%`).order("nombre").limit(100),
  ])
  if (history.error || variants.error) return NextResponse.json({ error: "No se pudieron cargar los reemplazos. Reintentá." }, { status: 500 })
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
