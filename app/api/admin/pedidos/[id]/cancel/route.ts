import { NextResponse } from "next/server"

import { requireOperator } from "@/app/api/admin/clientes/_auth"
import { upsertCustomerCancelledOrderNotification } from "@/lib/orders/customer-cancellation-notification"
import { sendOrderStateEmail } from "@/lib/orders/order-status-notifications"
import {
  ADMIN_ORDER_CANCELLATION_OTHER_REASON,
  ADMIN_ORDER_CANCELLATION_REASONS,
  type AdminOrderCancellationAction,
} from "@/lib/orders/admin-order-cancellation-reasons"
import type { SupabasePedido } from "@/lib/supabase/types"

const VALID_ACTIONS: AdminOrderCancellationAction[] = ["reject", "cancel"]
const VALID_REASON_CODES = new Set(ADMIN_ORDER_CANCELLATION_REASONS.map((r) => r.value))

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireOperator(request)

  if ("error" in auth) return auth.error

  const { id } = await params
  const orderId = Number(id)

  if (!Number.isFinite(orderId) || orderId <= 0) {
    return NextResponse.json({ error: "Pedido inválido." }, { status: 400 })
  }

  const body = (await request.json().catch(() => null)) as {
    action?: unknown
    reasonCode?: unknown
    reasonText?: unknown
  } | null

  const action = body?.action
  if (typeof action !== "string" || !VALID_ACTIONS.includes(action as AdminOrderCancellationAction)) {
    return NextResponse.json({ error: "Acción inválida." }, { status: 400 })
  }

  const reasonCode = typeof body?.reasonCode === "string" ? body.reasonCode.trim() : ""
  if (!VALID_REASON_CODES.has(reasonCode)) {
    return NextResponse.json({ error: "Seleccioná un motivo." }, { status: 400 })
  }

  const reasonText = typeof body?.reasonText === "string" ? body.reasonText.trim() : ""
  if (reasonCode === ADMIN_ORDER_CANCELLATION_OTHER_REASON && reasonText.length < 3) {
    return NextResponse.json(
      { error: "Contanos el motivo con al menos 3 caracteres." },
      { status: 400 },
    )
  }

  if (reasonText.length > 600) {
    return NextResponse.json(
      { error: "El motivo no puede superar los 600 caracteres." },
      { status: 400 },
    )
  }

  const { data: order, error: cancellationError } = await auth.admin.rpc(
    "admin_cancel_order",
    {
      p_order_id: orderId,
      p_admin_id: auth.user.id,
      p_admin_role: auth.profile.rol,
      p_action: action,
      p_reason_code: reasonCode,
      p_reason_text: reasonText,
    },
  )

  if (cancellationError || !order) {
    const message = cancellationError?.message ?? ""

    if (message.includes("ORDER_NOT_FOUND")) {
      return NextResponse.json({ error: "No encontramos el pedido." }, { status: 404 })
    }
    if (message.includes("ORDER_ALREADY_CANCELLED")) {
      return NextResponse.json({ error: "El pedido ya está cancelado." }, { status: 409 })
    }
    if (message.includes("ORDER_ALREADY_INVOICED")) {
      return NextResponse.json(
        {
          error:
            "El pedido ya fue facturado: no se puede cancelar desde acá. Usá el flujo de Nota de Crédito.",
        },
        { status: 409 },
      )
    }
    if (message.includes("ORDER_ALREADY_DISPATCHED")) {
      return NextResponse.json(
        { error: "El pedido ya fue despachado: no se puede cancelar como una compra estándar." },
        { status: 409 },
      )
    }
    if (
      message.includes("ANDREANI_CREATION_IN_PROGRESS") ||
      message.includes("ANDREANI_RECONCILIATION_REQUIRED")
    ) {
      return NextResponse.json(
        {
          error:
            "El pedido tiene una creación de envío en curso o pendiente de conciliación. Resolvé primero el estado de Andreani antes de cancelar.",
        },
        { status: 409 },
      )
    }
    if (message.includes("ORDER_ALREADY_PAID_USE_CANCEL")) {
      return NextResponse.json(
        { error: "Este pedido ya tiene pago confirmado: usá \"Cancelar pedido\"." },
        { status: 409 },
      )
    }
    if (message.includes("ORDER_NOT_PAID_USE_REJECT")) {
      return NextResponse.json(
        { error: "Este pedido no tiene pago confirmado: usá \"Rechazar pedido\"." },
        { status: 409 },
      )
    }
    if (message.includes("INVALID_REASON")) {
      return NextResponse.json({ error: "Indicá un motivo válido." }, { status: 400 })
    }

    return NextResponse.json(
      { error: "No se pudo procesar la acción de forma segura." },
      { status: 500 },
    )
  }

  const updatedOrder = order as SupabasePedido

  await sendOrderStateEmail(updatedOrder)
  try {
    await upsertCustomerCancelledOrderNotification(auth.admin, updatedOrder)
  } catch (notificationError) {
    console.log("No se pudo crear notificación de cancelación", notificationError)
  }

  return NextResponse.json({
    order: updatedOrder,
    message: action === "reject" ? "Pedido rechazado." : "Pedido cancelado.",
  })
}
