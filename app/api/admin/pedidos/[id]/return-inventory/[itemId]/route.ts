import { NextResponse } from "next/server"

import { requireAdmin } from "@/app/api/admin/clientes/_auth"
import type { SupabasePedidoItem } from "@/lib/supabase/types"

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; itemId: string }> },
) {
  const auth = await requireAdmin(request)

  if ("error" in auth) return auth.error

  const { id, itemId } = await params
  const orderId = Number(id)
  const orderItemId = Number(itemId)
  const body = (await request.json()) as {
    claimId?: unknown
    restockedQuantity?: unknown
    writtenOffQuantity?: unknown
    note?: unknown
  }
  const claimId = Number(body.claimId)
  const restockedQuantity = Number(body.restockedQuantity)
  const writtenOffQuantity = Number(body.writtenOffQuantity)
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 1000) : ""

  if (
    !Number.isInteger(orderId) ||
    orderId <= 0 ||
    !Number.isInteger(orderItemId) ||
    orderItemId <= 0 ||
    !Number.isInteger(claimId) ||
    claimId <= 0
  ) {
    return NextResponse.json({ error: "Pedido o producto inválido." }, { status: 400 })
  }

  if (
    !Number.isInteger(restockedQuantity) ||
    restockedQuantity < 0 ||
    !Number.isInteger(writtenOffQuantity) ||
    writtenOffQuantity < 0
  ) {
    return NextResponse.json(
      { error: "Ingresá cantidades enteras iguales o mayores que cero." },
      { status: 400 },
    )
  }

  if (writtenOffQuantity > 0 && note.length < 3) {
    return NextResponse.json(
      { error: "Indicá en la observación el motivo de la baja o pérdida." },
      { status: 400 },
    )
  }

  const { data: formalClaim, error: claimError } = await auth.admin
    .from("order_claims")
    .select("id, affected_items")
    .eq("id", claimId)
    .eq("order_id", orderId)
    .not("failure_type", "in", "(cancelar_compra,consulta_pedido)")
    .maybeSingle()

  if (claimError) {
    return NextResponse.json(
      { error: "No se pudo verificar el reclamo asociado al pedido." },
      { status: 500 },
    )
  }

  if (!formalClaim) {
    return NextResponse.json(
      { error: "No se puede modificar el inventario porque este pedido no tiene un reclamo formal." },
      { status: 409 },
    )
  }

  const claimedItem = Array.isArray(formalClaim.affected_items)
    ? formalClaim.affected_items.find(
        (item: { order_item_id?: unknown }) =>
          Number(item.order_item_id) === orderItemId,
      )
    : null
  const claimedQuantity = Number(
    (claimedItem as { quantity?: unknown } | null)?.quantity,
  )
  const processedQuantity = restockedQuantity + writtenOffQuantity

  if (!claimedItem || !Number.isInteger(claimedQuantity) || claimedQuantity <= 0) {
    return NextResponse.json(
      {
        error:
          "Este producto no forma parte del reclamo. Corregí los productos reclamados antes de registrar la recepción.",
      },
      { status: 409 },
    )
  }

  if (processedQuantity > claimedQuantity) {
    return NextResponse.json(
      { error: "La recepción no puede superar la cantidad incluida en el reclamo." },
      { status: 400 },
    )
  }

  const { data, error } = await auth.admin.rpc("process_order_item_return_inventory", {
    p_order_id: orderId,
    p_order_item_id: orderItemId,
    p_restocked_quantity: restockedQuantity,
    p_written_off_quantity: writtenOffQuantity,
    p_note: note,
    p_processed_by: auth.user.id,
  })

  if (error || !data) {
    return NextResponse.json(
      { error: error?.message || "No se pudo registrar el destino del producto devuelto." },
      { status: 409 },
    )
  }

  return NextResponse.json({ item: data as SupabasePedidoItem })
}
