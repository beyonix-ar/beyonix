import { NextResponse } from "next/server"

import { requireAdmin } from "@/app/api/admin/clientes/_auth"
import { appendOrderAuditEvent } from "@/lib/orders/order-audit"
import {
  DEFAULT_PRODUCT_WARRANTY_MONTHS,
  getWarrantyExpiration,
  normalizeWarrantyStatus,
} from "@/lib/orders/warranty"

function parseDateInput(value: unknown) {
  if (value === null || value === "") return null
  if (typeof value !== "string") return undefined

  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; itemId: string }> },
) {
  const auth = await requireAdmin(request)
  if ("error" in auth) return auth.error

  const { id, itemId } = await params
  const orderId = Number(id)
  const orderItemId = Number(itemId)

  if (!Number.isFinite(orderId) || !Number.isFinite(orderItemId)) {
    return NextResponse.json({ error: "Pedido o producto inválido." }, { status: 400 })
  }

  const body = (await request.json()) as {
    delivered_at?: unknown
    warranty_started_at?: unknown
    warranty_expires_at?: unknown
    warranty_months?: unknown
    warranty_status?: unknown
    forceShortWarranty?: unknown
  }

  const deliveredAt = parseDateInput(body.delivered_at)
  const warrantyStartedAt = parseDateInput(body.warranty_started_at)
  const warrantyExpiresAt = parseDateInput(body.warranty_expires_at)
  const warrantyStatus = normalizeWarrantyStatus(body.warranty_status)
  const warrantyMonths =
    body.warranty_months === undefined || body.warranty_months === null
      ? DEFAULT_PRODUCT_WARRANTY_MONTHS
      : Number(body.warranty_months)

  if (
    deliveredAt === undefined ||
    warrantyStartedAt === undefined ||
    warrantyExpiresAt === undefined ||
    !warrantyStatus ||
    !Number.isFinite(warrantyMonths) ||
    warrantyMonths < 0
  ) {
    return NextResponse.json({ error: "Datos de garantía inválidos." }, { status: 400 })
  }

  if (warrantyStartedAt && warrantyExpiresAt) {
    const minimumExpiresAt = getWarrantyExpiration(
      warrantyStartedAt,
      DEFAULT_PRODUCT_WARRANTY_MONTHS,
    )

    if (
      new Date(warrantyExpiresAt).getTime() < new Date(minimumExpiresAt).getTime() &&
      body.forceShortWarranty !== true
    ) {
      return NextResponse.json(
        {
          error:
            "El vencimiento indicado reduce la garantía por debajo de 6 meses desde el inicio. Confirmá explícitamente para guardar.",
          requiresShortWarrantyConfirmation: true,
        },
        { status: 409 },
      )
    }
  }

  const { data: order, error: orderError } = await auth.admin
    .from("ordenes")
    .select("id, delivered_at")
    .eq("id", orderId)
    .maybeSingle()

  if (orderError || !order) {
    return NextResponse.json({ error: "No encontramos el pedido." }, { status: 404 })
  }

  const { data: item, error: itemError } = await auth.admin
    .from("orden_items")
    .select("id, orden_id, warranty_started_at, warranty_expires_at, warranty_months, warranty_status")
    .eq("id", orderItemId)
    .eq("orden_id", orderId)
    .maybeSingle()

  if (itemError || !item) {
    return NextResponse.json(
      { error: "No encontramos el producto dentro del pedido." },
      { status: 404 },
    )
  }

  const previous = {
    delivered_at: order.delivered_at ?? null,
    warranty_started_at: item.warranty_started_at ?? null,
    warranty_expires_at: item.warranty_expires_at ?? null,
    warranty_months: item.warranty_months ?? null,
    warranty_status: item.warranty_status ?? null,
  }
  const next = {
    delivered_at: deliveredAt,
    warranty_started_at: warrantyStartedAt,
    warranty_expires_at: warrantyExpiresAt,
    warranty_months: warrantyMonths,
    warranty_status: warrantyStatus,
  }

  const { error: orderUpdateError } = await auth.admin
    .from("ordenes")
    .update({ delivered_at: deliveredAt })
    .eq("id", orderId)

  if (orderUpdateError) {
    return NextResponse.json(
      { error: orderUpdateError.message || "No se pudo actualizar la entrega." },
      { status: 500 },
    )
  }

  const { data: updatedItem, error: updateError } = await auth.admin
    .from("orden_items")
    .update({
      warranty_started_at: warrantyStartedAt,
      warranty_expires_at: warrantyExpiresAt,
      warranty_months: warrantyMonths,
      warranty_status: warrantyStatus,
    })
    .eq("id", orderItemId)
    .eq("orden_id", orderId)
    .select("*")
    .single()

  if (updateError || !updatedItem) {
    return NextResponse.json(
      { error: updateError?.message || "No se pudo actualizar la garantía." },
      { status: 500 },
    )
  }

  await appendOrderAuditEvent(auth.admin, {
    orderId,
    actorType: "admin",
    actorId: auth.user.id,
    action: "order_item_warranty_updated",
    previousStatus: String(previous.warranty_status ?? ""),
    newStatus: warrantyStatus,
    metadata: {
      order_item_id: orderItemId,
      previous,
      next,
    },
  })

  return NextResponse.json({
    ok: true,
    item: updatedItem,
    delivered_at: deliveredAt,
  })
}
