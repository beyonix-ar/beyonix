import { NextResponse } from "next/server"

import { sendOrderStatusEmail } from "@/lib/email/send-order-status-email"
import {
  buildCustomerCancelledOrderNotification,
  upsertCustomerCancelledOrderNotification,
} from "@/lib/orders/customer-cancellation-notification"
import { appendOrderAuditEvent } from "@/lib/orders/order-audit"
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
  paid_at?: string | null
  cancelled_at?: string | null
}

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
    ["enviado", "en_camino", "entregado"].includes(estado) ||
    Boolean(order.tracking_number || order.andreani_tracking || order.andreani_envio_id) ||
    ["camino", "tránsito", "transito", "distribución", "distribucion", "reparto", "visita", "entregado"].some(
      (status) => andreaniStatus.includes(status),
    )
  )
}

function isOrderInvoiced(order: CancelableOrder) {
  return (
    order.invoice_status === "authorized" ||
    order.invoice_status === "processing" ||
    Boolean(order.invoice_cae) ||
    Boolean(order.invoice_number && order.invoice_point)
  )
}

function isPaymentConfirmed(order: CancelableOrder) {
  return (
    Boolean(order.paid_at) ||
    ["confirmado", "approved", "confirmed"].includes(order.payment_status ?? "")
  )
}

function hasPaymentProofPendingReview(order: CancelableOrder) {
  return Boolean(order.payment_proof_url) &&
    ["en_revision", "pendiente_comprobante", "pending"].includes(
      order.payment_status ?? "",
    )
}

function isMissingColumnError(error: { message?: string; code?: string } | null) {
  return (
    error?.code === "PGRST204" ||
    error?.message?.includes("schema cache") ||
    error?.message?.includes("cancelled_at")
  )
}

function getCancellationFinancialStatus(order: CancelableOrder) {
  if (isPaymentConfirmed(order)) return "refund_pending"
  if (hasPaymentProofPendingReview(order)) return "cancellation_requested"
  return "cancelled"
}

function buildCancellationUpdate(
  order: CancelableOrder,
  includeCancelledAt: boolean,
  cancelledAt: string,
  userId: string,
) {
  const financialStatus = getCancellationFinancialStatus(order)
  const invoiceIssued = isOrderInvoiced(order)

  return {
    estado: "cancelado",
    financial_status: financialStatus,
    cancellation_requested_at: cancelledAt,
    cancellation_requested_by: userId,
    ...(financialStatus === "refund_pending"
      ? {
          refund_pending_at: cancelledAt,
          credit_note_required: invoiceIssued,
        }
      : {
          credit_note_required: false,
        }),
    ...(includeCancelledAt ? { cancelled_at: cancelledAt } : {}),
  }
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
    .select("id, usuario_id, cliente_email, cliente_nombre, estado, tracking_number, andreani_tracking, andreani_envio_id, andreani_estado, delivered_at, invoice_status, invoice_cae, invoice_number, invoice_point, payment_status, payment_proof_url, payment_proof_uploaded_at, financial_status, paid_at")
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

  const cancelledAt = new Date().toISOString()
  const previousFinancialStatus =
    order.financial_status ?? order.payment_status ?? "pending_payment"
  const nextFinancialStatus = getCancellationFinancialStatus(order)
  let { data: updatedOrder, error: updateError } = await admin
    .from("ordenes")
    .update(buildCancellationUpdate(order, true, cancelledAt, user.id))
    .eq("id", order.id)
    .not("estado", "in", "(cancelado,enviado,en_camino,entregado)")
    .is("tracking_number", null)
    .is("andreani_tracking", null)
    .is("andreani_envio_id", null)
    .select("*")
    .maybeSingle()

  if (isMissingColumnError(updateError)) {
    console.log("cancelled_at no disponible en ordenes; reintentando cancelación sin timestamp", updateError?.message)
    const retryResult = await admin
      .from("ordenes")
      .update(buildCancellationUpdate(order, false, cancelledAt, user.id))
      .eq("id", order.id)
      .not("estado", "in", "(cancelado,enviado,en_camino,entregado)")
      .is("tracking_number", null)
      .is("andreani_tracking", null)
      .is("andreani_envio_id", null)
      .select("*")
      .maybeSingle()

    updatedOrder = retryResult.data
    updateError = retryResult.error
  }

  if (updateError) {
    return NextResponse.json(
      { error: updateError.message || "No se pudo cancelar la compra." },
      { status: 500 },
    )
  }

  if (!updatedOrder) {
    return NextResponse.json(
      { error: "Esta compra ya no se puede cancelar desde la cuenta." },
      { status: 409 },
    )
  }

  await notifyCustomerCancellation(admin, updatedOrder)
  await appendOrderAuditEvent(admin, {
    orderId: order.id,
    actorType: "customer",
    actorId: user.id,
    action:
      nextFinancialStatus === "refund_pending"
        ? "cancellation_requested_refund_pending"
        : "cancellation_requested",
    previousStatus: previousFinancialStatus,
    newStatus: nextFinancialStatus,
    metadata: {
      cancelledAt,
      paymentStatus: order.payment_status ?? null,
      paymentProofUrl: order.payment_proof_url ?? null,
      invoiceIssued: isOrderInvoiced(order),
      creditNoteRequired:
        nextFinancialStatus === "refund_pending" && isOrderInvoiced(order),
    },
  })

  return NextResponse.json({
    order: updatedOrder,
    message:
      nextFinancialStatus === "refund_pending"
        ? "Ya recibimos tu solicitud de arrepentimiento y gestionaremos el reintegro."
        : "Tu compra fue cancelada correctamente.",
  })
}
