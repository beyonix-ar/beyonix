import { NextResponse } from "next/server"

import { requireAdmin } from "@/app/api/admin/clientes/_auth"
import { appendOrderAuditEvent } from "@/lib/orders/order-audit"

type RequestedAffectedItem = {
  orderItemId?: unknown
  quantity?: unknown
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ claimId: string }> },
) {
  const auth = await requireAdmin(request)
  if ("error" in auth) return auth.error

  const { claimId: rawClaimId } = await params
  const claimId = Number(rawClaimId)
  const body = (await request.json()) as { items?: unknown }

  if (!Number.isInteger(claimId) || claimId <= 0) {
    return NextResponse.json({ error: "Reclamo inválido." }, { status: 400 })
  }

  if (!Array.isArray(body.items) || body.items.length === 0) {
    return NextResponse.json(
      { error: "Seleccioná al menos un producto reclamado." },
      { status: 400 },
    )
  }

  const requestedItems = body.items as RequestedAffectedItem[]
  const normalizedItems = requestedItems.map((item) => ({
    order_item_id: Number(item.orderItemId),
    quantity: Number(item.quantity),
  }))
  const uniqueItemIds = new Set(normalizedItems.map((item) => item.order_item_id))

  if (
    uniqueItemIds.size !== normalizedItems.length ||
    normalizedItems.some(
      (item) =>
        !Number.isInteger(item.order_item_id) ||
        item.order_item_id <= 0 ||
        !Number.isInteger(item.quantity) ||
        item.quantity <= 0,
    )
  ) {
    return NextResponse.json(
      { error: "Los productos o cantidades informados no son válidos." },
      { status: 400 },
    )
  }

  const { data: claim, error: claimError } = await auth.admin
    .from("order_claims")
    .select("id, order_id, failure_type, affected_items")
    .eq("id", claimId)
    .maybeSingle()

  if (claimError || !claim) {
    return NextResponse.json({ error: "No encontramos el reclamo." }, { status: 404 })
  }

  if (["cancelar_compra", "consulta_pedido"].includes(claim.failure_type ?? "")) {
    return NextResponse.json(
      { error: "Este caso no admite productos devueltos." },
      { status: 409 },
    )
  }

  const { data: orderItems, error: orderItemsError } = await auth.admin
    .from("orden_items")
    .select("id, cantidad, return_inventory_processed_at")
    .eq("orden_id", claim.order_id)
    .in("id", [...uniqueItemIds])

  if (orderItemsError || (orderItems ?? []).length !== normalizedItems.length) {
    return NextResponse.json(
      { error: "Uno de los productos no pertenece al pedido." },
      { status: 400 },
    )
  }

  const orderItemsById = new Map((orderItems ?? []).map((item) => [Number(item.id), item]))
  for (const item of normalizedItems) {
    const orderItem = orderItemsById.get(item.order_item_id)
    if (!orderItem || item.quantity > Number(orderItem.cantidad ?? 0)) {
      return NextResponse.json(
        { error: "La cantidad reclamada no puede superar la cantidad comprada." },
        { status: 400 },
      )
    }
  }

  const previousItems = Array.isArray(claim.affected_items)
    ? claim.affected_items
    : []
  const previousById = new Map(
    previousItems.map((item: { order_item_id?: unknown; quantity?: unknown }) => [
      Number(item.order_item_id),
      Number(item.quantity),
    ]),
  )

  const { data: processedItems, error: processedItemsError } = await auth.admin
    .from("orden_items")
    .select("id")
    .eq("orden_id", claim.order_id)
    .not("return_inventory_processed_at", "is", null)

  if (processedItemsError) {
    return NextResponse.json(
      { error: "No se pudo validar la recepción de los productos." },
      { status: 500 },
    )
  }

  const requestedById = new Map(
    normalizedItems.map((item) => [item.order_item_id, item.quantity]),
  )
  const changesProcessedItem = (processedItems ?? []).some((item) => {
    const itemId = Number(item.id)
    return previousById.get(itemId) !== requestedById.get(itemId)
  })

  if (changesProcessedItem) {
    return NextResponse.json(
      {
        error:
          "No se puede modificar un producto cuya recepción de inventario ya fue registrada.",
      },
      { status: 409 },
    )
  }

  const affectedItems = [...normalizedItems].sort(
    (left, right) => left.order_item_id - right.order_item_id,
  )
  const updatedAt = new Date().toISOString()
  const { data: updatedClaim, error: updateError } = await auth.admin
    .from("order_claims")
    .update({
      affected_items: affectedItems,
      affected_items_updated_at: updatedAt,
      affected_items_updated_by: auth.user.id,
    })
    .eq("id", claim.id)
    .select()
    .single()

  if (updateError || !updatedClaim) {
    return NextResponse.json(
      { error: updateError?.message || "No se pudo corregir la selección." },
      { status: 500 },
    )
  }

  await appendOrderAuditEvent(auth.admin, {
    orderId: Number(claim.order_id),
    actorType: "admin",
    actorId: auth.user.id,
    action: "claim_affected_items_corrected",
    previousStatus: "affected_items",
    newStatus: "affected_items",
    metadata: {
      claimId: claim.id,
      previousItems,
      affectedItems,
    },
  })

  return NextResponse.json({ claim: updatedClaim })
}
