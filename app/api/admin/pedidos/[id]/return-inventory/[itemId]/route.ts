import { NextResponse } from "next/server"

import { requireAdmin } from "@/app/api/admin/clientes/_auth"
import { claimErrorResponse } from "@/lib/orders/claim-server"
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
    idempotencyKey?: unknown
  }
  const claimId = Number(body.claimId)
  const restockedQuantity = Number(body.restockedQuantity)
  const writtenOffQuantity = Number(body.writtenOffQuantity)
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 1000) : ""
  const idempotencyKey =
    typeof body.idempotencyKey === "string" && /^[A-Za-z0-9._:-]{8,240}$/.test(body.idempotencyKey)
      ? body.idempotencyKey
      : null

  if (!idempotencyKey) {
    return NextResponse.json(
      { error: "La operación no tiene una clave de idempotencia válida." },
      { status: 400 },
    )
  }

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

  // Devoluciones parciales sucesivas: el tope es lo reclamado MENOS lo que
  // ya se registró en eventos anteriores sobre este mismo ítem, no sólo lo
  // reclamado a secas (record_order_item_return_reception vuelve a validar
  // esto server-side de forma atómica; este chequeo es sólo para dar un
  // mensaje temprano y claro antes de llamar a la RPC).
  const { data: existingItem, error: existingItemError } = await auth.admin
    .from("orden_items")
    .select("return_restocked_quantity, return_written_off_quantity")
    .eq("id", orderItemId)
    .eq("orden_id", orderId)
    .maybeSingle()
  if (existingItemError) {
    return NextResponse.json(
      { error: "No se pudo verificar lo ya registrado para este producto." },
      { status: 500 },
    )
  }
  const alreadyReturned =
    Number(existingItem?.return_restocked_quantity ?? 0) +
    Number(existingItem?.return_written_off_quantity ?? 0)
  const remaining = claimedQuantity - alreadyReturned

  if (processedQuantity > remaining) {
    return NextResponse.json(
      {
        error:
          remaining <= 0
            ? "Ya se registró la recepción completa de este producto para el reclamo."
            : `Quedan ${remaining} unidad(es) disponibles para registrar de este producto.`,
      },
      { status: 400 },
    )
  }

  const { data, error } = await auth.admin.rpc("process_claim_return_inventory", {
    p_claim_id: claimId,
    p_order_id: orderId,
    p_order_item_id: orderItemId,
    p_restocked_quantity: restockedQuantity,
    p_written_off_quantity: writtenOffQuantity,
    p_note: note,
    p_processed_by: auth.user.id,
    p_idempotency_key: idempotencyKey,
  })

  if (error || !data) {
    return claimErrorResponse(error)
  }

  return NextResponse.json({ item: data as SupabasePedidoItem })
}
