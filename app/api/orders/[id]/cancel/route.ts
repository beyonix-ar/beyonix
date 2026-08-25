import { NextResponse } from "next/server"

import { sendOrderStatusEmail } from "@/lib/email/send-order-status-email"
import {
  buildCustomerCancelledOrderNotification,
  upsertCustomerCancelledOrderNotification,
} from "@/lib/orders/customer-cancellation-notification"
import { isOrderPaymentConfirmed } from "@/lib/orders/order-payment-status"
import { createAdminClient } from "@/lib/supabase/admin"
import { createClient } from "@/lib/supabase/server"

type CancelableOrder = {
  id: number
  usuario_id: string | null
  cliente_email?: string | null
  cliente_nombre?: string | null
  estado?: string | null
  tracking_number?: string | null
  andreani_tracking?: string | null
  andreani_envio_id?: string | null
  andreani_estado?: string | null
  delivered_at?: string | null
  invoice_status?: string | null
  invoice_cae?: string | null
  invoice_number?: number | null
  invoice_point?: number | null
  payment_status?: string | null
  payment_proof_url?: string | null
  payment_proof_uploaded_at?: string | null
  financial_status?: string | null
  credit_balance_used?: number | null
  paid_at?: string | null
  payment_confirmed_amount?: number | null
  cancelled_at?: string | null
}

const DISPATCHED_ORDER_STATUSES = [
  "enviado",
  "en_camino",
  "visita_fallida",
  "en_sucursal",
  "retiro_pendiente",
  "retiro_vencido",
  "en_devolucion",
  "devuelto_beyonix",
  "entregado",
]

function getOrderCode(orderId: number) {
  return `BX-${1000 + orderId}`
}

function isOrderDelivered(order: CancelableOrder) {
  const estado = (order.estado ?? "").toLowerCase()
  const andreaniStatus = (order.andreani_estado ?? "").toLowerCase()

  return (
    estado === "entregado" ||
    Boolean(order.delivered_at) ||
    andreaniStatus.includes("entregado")
  )
}

function isOrderDispatched(order: CancelableOrder) {
  const estado = (order.estado ?? "").toLowerCase()
  const andreaniStatus = (order.andreani_estado ?? "").toLowerCase()

  return (
    DISPATCHED_ORDER_STATUSES.includes(estado) ||
    Boolean(order.tracking_number || order.andreani_tracking || order.andreani_envio_id) ||
    ["camino", "tránsito", "transito", "distribución", "distribucion", "reparto", "visita", "entregado"].some(
      (status) => andreaniStatus.includes(status),
    )
  )
}

function hasPaymentProofPendingReview(order: CancelableOrder) {
  return Boolean(order.payment_proof_url) &&
    ["en_revision", "pendiente_comprobante", "pending"].includes(
      order.payment_status ?? "",
    )
}

function getCancellationFinancialStatus(order: CancelableOrder) {
  if (isOrderPaymentConfirmed(order)) return "refund_pending"
  if (hasPaymentProofPendingReview(order)) return "cancellation_requested"
  return "cancelled"
}

async function notifyCustomerCancellation(
  admin: ReturnType<typeof createAdminClient>,
  order: CancelableOrder,
) {
  const orderCode = getOrderCode(order.id)
  const financialStatus = getCancellationFinancialStatus(order)
  const needsRefund = financialStatus === "refund_pending"
  const notification = buildCustomerCancelledOrderNotification(order)

  if (order.usuario_id) {
    try {
      await upsertCustomerCancelledOrderNotification(admin, order)
    } catch (notificationError) {
      console.log("No se pudo crear notificación de cancelación", notificationError)
    }
  }

  try {
    await sendOrderStatusEmail({
      to: order.cliente_email,
      subject: needsRefund
        ? `Pedido cancelado ${orderCode}`
        : "Tu compra fue cancelada correctamente",
      html: `
        <h1>${notification.title}</h1>
        <p>Hola ${order.cliente_nombre ?? ""}, ${notification.body}</p>
      `,
    })
  } catch (emailError) {
    console.log("No se pudo enviar email de cancelación", emailError)
  }
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

  const body = (await request.json().catch(() => null)) as {
    reason?: unknown
  } | null
  const cancellationReason =
    typeof body?.reason === "string" ? body.reason.trim() : ""

  if (cancellationReason.length < 5) {
    return NextResponse.json(
      { error: "Contanos el motivo con al menos 5 caracteres." },
      { status: 400 },
    )
  }

  if (cancellationReason.length > 600) {
    return NextResponse.json(
      { error: "El motivo no puede superar los 600 caracteres." },
      { status: 400 },
    )
  }

  const admin = createAdminClient()
  const { data: order, error: orderError } = await admin
    .from("ordenes")
    .select("id, usuario_id, cliente_email, cliente_nombre, estado, tracking_number, andreani_tracking, andreani_envio_id, andreani_estado, delivered_at, invoice_status, invoice_cae, invoice_number, invoice_point, payment_status, payment_proof_url, payment_proof_uploaded_at, financial_status, credit_balance_used, paid_at, payment_confirmed_amount")
    .eq("id", orderId)
    .maybeSingle()

  if (orderError || !order) {
    return NextResponse.json({ error: "No encontramos el pedido." }, { status: 404 })
  }

  if (order.usuario_id !== user.id) {
    return NextResponse.json({ error: "No autorizado." }, { status: 403 })
  }

  if (
    (order.estado ?? "").toLowerCase() === "cancelado" ||
    ["cancelled", "refund_pending", "refunded"].includes(
      String(order.financial_status ?? ""),
    )
  ) {
    return NextResponse.json(
      { error: "La compra ya está cancelada." },
      { status: 409 },
    )
  }

  if (isOrderDelivered(order) || isOrderDispatched(order)) {
    return NextResponse.json(
      { error: "Esta compra ya no se puede cancelar desde la cuenta." },
      { status: 409 },
    )
  }

  const { data: cancellationResult, error: cancellationError } = await admin.rpc(
    "request_customer_order_cancellation_with_claim",
    {
      p_order_id: order.id,
      p_user_id: user.id,
      p_reason: cancellationReason,
    },
  )

  if (cancellationError || !cancellationResult) {
    const message = cancellationError?.message ?? ""
    if (message.includes("ORDER_NOT_FOUND")) {
      return NextResponse.json({ error: "No encontramos el pedido." }, { status: 404 })
    }
    if (
      message.includes("ORDER_ALREADY_CANCELLED") ||
      message.includes("ORDER_ALREADY_DISPATCHED")
    ) {
      return NextResponse.json(
        { error: "Esta compra ya no se puede cancelar desde la cuenta." },
        { status: 409 },
      )
    }
    return NextResponse.json(
      { error: "No se pudo cancelar la compra de forma segura." },
      { status: 500 },
    )
  }

  const updatedOrder = cancellationResult as unknown as CancelableOrder
  const nextFinancialStatus = updatedOrder.financial_status ?? "cancelled"

  await notifyCustomerCancellation(admin, updatedOrder)
  return NextResponse.json({
    order: updatedOrder,
    message:
      nextFinancialStatus === "refund_pending"
        ? "Ya recibimos tu solicitud de arrepentimiento y gestionaremos el reintegro."
        : "Tu compra fue cancelada correctamente.",
  })
}
