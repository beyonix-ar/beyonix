import { NextResponse } from "next/server"

import { requireAdmin } from "@/app/api/admin/clientes/_auth"
import { sendOrderStatusEmail } from "@/lib/email/send-order-status-email"
import { appendOrderAuditEvent } from "@/lib/orders/order-audit"

const ALLOWED_PAYMENT_STATUSES = [
  "pendiente_comprobante",
  "en_revision",
  "confirmado",
  "rechazado",
]

function getOrderCode(orderId: number) {
  return `BX-${1000 + orderId}`
}

function isOrderInvoiced(order: {
  invoice_status?: string | null
  invoice_cae?: string | null
  invoice_number?: number | null
  invoice_point?: number | null
}) {
  return (
    order.invoice_status === "authorized" ||
    order.invoice_status === "processing" ||
    Boolean(order.invoice_cae) ||
    Boolean(order.invoice_number && order.invoice_point)
  )
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(request)

  if ("error" in auth) return auth.error

  const { id } = await params
  const pedidoId = Number(id)
  const body = (await request.json()) as {
    payment_status?: string
    observation?: string
  }
  const paymentStatus = String(body.payment_status ?? "")
  const observation =
    typeof body.observation === "string"
      ? body.observation.trim().slice(0, 1000)
      : ""

  if (!Number.isFinite(pedidoId) || pedidoId <= 0) {
    return NextResponse.json({ error: "Pedido inválido." }, { status: 400 })
  }

  if (!ALLOWED_PAYMENT_STATUSES.includes(paymentStatus)) {
    return NextResponse.json({ error: "Estado de pago inválido." }, { status: 400 })
  }

  const { data: currentOrder, error: currentOrderError } = await auth.admin
    .from("ordenes")
    .select("id, estado, total, payment_status, payment_proof_url, payment_proof_file_name, paid_at, financial_status, invoice_status, invoice_cae, invoice_number, invoice_point")
    .eq("id", pedidoId)
    .eq("payment_method_id", "transferencia")
    .maybeSingle()

  if (currentOrderError || !currentOrder) {
    return NextResponse.json(
      { error: "Solo los pedidos por transferencia admiten cambios manuales de pago." },
      { status: 400 },
    )
  }

  if (paymentStatus === "confirmado" && !currentOrder.payment_proof_url) {
    return NextResponse.json(
      { error: "No se puede confirmar el pago sin comprobante cargado." },
      { status: 409 },
    )
  }

  const now = new Date().toISOString()
  const orderWasCancelled =
    currentOrder.estado === "cancelado" ||
    ["cancellation_requested", "refund_pending", "cancelled"].includes(
      String(currentOrder.financial_status ?? ""),
    )
  const previousFinancialStatus =
    currentOrder.financial_status ??
    currentOrder.payment_status ??
    "pending_payment"
  const nextFinancialStatus =
    paymentStatus === "confirmado"
      ? orderWasCancelled
        ? "refund_pending"
        : "payment_confirmed"
      : paymentStatus === "en_revision"
        ? "payment_submitted"
        : paymentStatus === "rechazado"
          ? orderWasCancelled
            ? "cancelled"
            : "pending_payment"
          : "pending_payment"

  const updatePayload: Record<string, string | null | number | boolean> = {
    payment_status: paymentStatus,
    estado:
      paymentStatus === "confirmado"
        ? orderWasCancelled
          ? "cancelado"
          : "pagado"
        : orderWasCancelled
          ? "cancelado"
          : "pendiente",
    financial_status: nextFinancialStatus,
    paid_at:
      paymentStatus === "confirmado" ? currentOrder.paid_at ?? now : null,
  }

  if (paymentStatus === "confirmado") {
    updatePayload.order_change_status = "change_approved"
    updatePayload.order_change_extra_amount = 0
    updatePayload.payment_confirmed_by = auth.user.id
    updatePayload.payment_confirmed_at = now
    updatePayload.payment_confirmed_amount = Number(currentOrder.total ?? 0)
    updatePayload.payment_confirmation_observation = observation || null

    if (orderWasCancelled) {
      updatePayload.refund_pending_at = now
      updatePayload.credit_note_required = isOrderInvoiced(currentOrder)
    }
  }

  const { data, error } = await auth.admin
    .from("ordenes")
    .update(updatePayload)
    .eq("id", pedidoId)
    .eq("payment_method_id", "transferencia")
    .select()
    .single()

  if (error || !data) {
    if (error?.code === "PGRST116") {
      return NextResponse.json(
        { error: "Solo los pedidos por transferencia admiten cambios manuales de pago." },
        { status: 400 },
      )
    }

    return NextResponse.json(
      { error: error?.message || "No se pudo actualizar el estado de pago." },
      { status: 500 },
    )
  }

  if (currentOrder.payment_status !== paymentStatus && paymentStatus === "confirmado") {
    await appendOrderAuditEvent(auth.admin, {
      orderId: data.id,
      actorType: "admin",
      actorId: auth.user.id,
      action: orderWasCancelled
        ? "payment_confirmed_after_cancellation"
        : "payment_confirmed",
      previousStatus: previousFinancialStatus,
      newStatus: nextFinancialStatus,
      metadata: {
        amount: Number(currentOrder.total ?? 0),
        proofUrl: currentOrder.payment_proof_url,
        proofFileName: currentOrder.payment_proof_file_name,
        observation: observation || null,
      },
    })

    const orderCode = getOrderCode(data.id)
    await sendOrderStatusEmail({
      to: data.cliente_email,
      subject: `Comprobante aceptado ${orderCode}`,
      html: `
        <h1>Comprobante aceptado</h1>
        <p>Hola ${data.cliente_nombre ?? ""}, validamos el pago del pedido ${orderCode}.</p>
        <p>Tu compra ya está en preparación. Te avisaremos cuando sea despachada.</p>
      `,
    })
  } else if (currentOrder.payment_status !== paymentStatus) {
    await appendOrderAuditEvent(auth.admin, {
      orderId: data.id,
      actorType: "admin",
      actorId: auth.user.id,
      action: `payment_status_${paymentStatus}`,
      previousStatus: previousFinancialStatus,
      newStatus: nextFinancialStatus,
      metadata: {
        observation: observation || null,
      },
    })
  }

  return NextResponse.json({ order: data })
}
