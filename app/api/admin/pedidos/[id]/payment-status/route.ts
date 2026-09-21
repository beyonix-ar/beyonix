import { NextResponse } from "next/server"

import { requireAdmin } from "@/app/api/admin/clientes/_auth"
import { sendOrderStatusEmail } from "@/lib/email/send-order-status-email"
import { appendOrderAuditEvent } from "@/lib/orders/order-audit"
import {
  TRANSFER_PAYMENT_STATUSES,
  getTransferPaymentTransitionError,
} from "@/lib/orders/transfer-payment-status"

function getOrderCode(orderId: number) {
  return `BX-${1000 + orderId}`
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

  if (!(TRANSFER_PAYMENT_STATUSES as readonly string[]).includes(paymentStatus)) {
    return NextResponse.json({ error: "Estado de pago inválido." }, { status: 400 })
  }

  const { data: currentOrder, error: currentOrderError } = await auth.admin
    .from("ordenes")
    .select("id, estado, total, external_amount_due, credit_balance_used, payment_status, payment_proof_url, payment_proof_file_name, paid_at, financial_status, invoice_status, invoice_cae, invoice_number, invoice_point")
    .eq("id", pedidoId)
    .eq("payment_method_id", "transferencia")
    .maybeSingle()

  if (currentOrderError || !currentOrder) {
    return NextResponse.json(
      { error: "Solo los pedidos por transferencia admiten cambios manuales de pago." },
      { status: 400 },
    )
  }

  const transitionError = getTransferPaymentTransitionError({
    currentStatus: currentOrder.payment_status,
    nextStatus: paymentStatus,
    hasProof: Boolean(currentOrder.payment_proof_url),
    observation,
  })
  if (transitionError) {
    return NextResponse.json(
      { error: transitionError },
      { status: 409 },
    )
  }

  const previousFinancialStatus = currentOrder.financial_status ?? currentOrder.payment_status ?? "pending_payment"
  const { data, error } = await auth.admin.rpc("review_manual_transfer_payment", {
    p_order_id: pedidoId,
    p_actor_id: auth.user.id,
    p_expected_status: currentOrder.payment_status,
    p_next_status: paymentStatus,
    p_observation: observation,
  })

  if (error || !data) {
    if (!error || /TRANSFER_(CANCELLATION_CONFLICT|PAYMENT_CONFLICT|INVALID_TRANSITION)/.test(error.message)) {
      return NextResponse.json(
        { error: "El estado del pago cambió mientras se procesaba la revisión. Actualizá el pedido e intentá nuevamente." },
        { status: 409 },
      )
    }

    // El guardián de inventario (trigger validate_inventory_order_confirmation)
    // rechaza confirmar una orden como pagada si el stock derivado real ya no
    // alcanza para sus ítems -- puede pasar si la reserva de checkout venció
    // y otra compra se llevó las unidades antes de que se aprobara este
    // comprobante. Se falla cerrado: la orden NO queda pagada, y el admin ve
    // un motivo claro en vez del código técnico crudo del trigger.
    if (/checkout_stock_insufficient/i.test(error?.message ?? "")) {
      await appendOrderAuditEvent(auth.admin, {
        orderId: pedidoId,
        actorType: "admin",
        actorId: auth.user.id,
        action: "payment_confirmation_blocked_stock_conflict",
        previousStatus: previousFinancialStatus,
        newStatus: previousFinancialStatus,
        metadata: { attemptedPaymentStatus: paymentStatus, observation: observation || null },
      })

      return NextResponse.json(
        {
          error:
            "No se pudo confirmar el pago: el stock de uno o más productos de este pedido ya no alcanza. Revisá el inventario antes de reintentar.",
        },
        { status: 409 },
      )
    }

    return NextResponse.json(
      { error: error?.message || "No se pudo actualizar el estado de pago." },
      { status: 500 },
    )
  }

  if (currentOrder.payment_status !== paymentStatus && paymentStatus === "confirmado") {
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
  }

  return NextResponse.json({ order: data })
}
