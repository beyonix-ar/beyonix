import { NextResponse } from "next/server"

import { sendOrderStatusEmail } from "@/lib/email/send-order-status-email"
import { buildCustomerCancelledOrderNotification } from "@/lib/orders/customer-cancellation-notification"
import { isOrderDispatchCutoffReached } from "@/lib/orders/dispatch-cutoff"
import { isCustomerOrderOwner } from "@/lib/orders/customer-order-ownership"
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
  andreani_handed_over_at?: string | null
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
  cancellation_requested_at?: string | null
}

/**
 * Auditoría Andreani Parte 4/4: request_customer_order_cancellation_with_claim
 * devuelve to_jsonb(v_order), es decir la fila COMPLETA de "ordenes"
 * (andreani_contrato, andreani_creation_environment,
 * andreani_creation_claim_token, andreani_creation_attempts, etc.). Nunca se
 * reenvía esa fila tal cual al cliente -- se arma acá el contrato público
 * explícito, con sólo lo que "Mis compras" necesita para reflejar el
 * resultado de la cancelación.
 */
function toCustomerCancellationOrderView(order: CancelableOrder) {
  return {
    id: order.id,
    estado: order.estado ?? null,
    financial_status: order.financial_status ?? null,
    cancelled_at: order.cancelled_at ?? null,
    cancellation_requested_at: order.cancellation_requested_at ?? null,
  }
}

const DISPATCHED_MESSAGE = "Tu pedido ya fue despachado y no puede cancelarse en este momento."

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

/**
 * La campana del cliente la escribe la base (notify_customer_order_cancelled,
 * una sola vez y con el estado físico real); acá sólo se manda el email.
 */
async function emailCustomerCancellation(order: CancelableOrder) {
  const orderCode = getOrderCode(order.id)
  const notification = buildCustomerCancelledOrderNotification(order)

  try {
    await sendOrderStatusEmail({
      to: order.cliente_email,
      subject: `Recibimos la cancelación de tu pedido ${orderCode}`,
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
  const [{ data: order, error: orderError }, packageResult] = await Promise.all([
    admin
      .from("ordenes")
      .select("id, usuario_id, cliente_email, cliente_nombre, estado, tracking_number, andreani_tracking, andreani_envio_id, andreani_estado, andreani_handed_over_at, delivered_at, invoice_status, invoice_cae, invoice_number, invoice_point, payment_status, payment_proof_url, payment_proof_uploaded_at, financial_status, credit_balance_used, paid_at, payment_confirmed_amount")
      .eq("id", orderId)
      .maybeSingle(),
    admin.from("order_packages").select("id").eq("order_id", orderId).maybeSingle(),
  ])

  if (orderError || !order) {
    return NextResponse.json({ error: "No encontramos el pedido." }, { status: 404 })
  }
  if (packageResult.error) {
    return NextResponse.json({ error: "No se pudo cancelar la compra de forma segura." }, { status: 500 })
  }

  if (!isCustomerOrderOwner(order, user)) {
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

  // Atajo de UX: la RPC vuelve a validar el corte con el pedido bloqueado.
  if (isOrderDelivered(order)) {
    return NextResponse.json(
      { error: "Tu pedido ya fue entregado. Podés solicitar una devolución desde Ayuda." },
      { status: 409 },
    )
  }
  if (isOrderDispatchCutoffReached(order, Boolean(packageResult.data))) {
    return NextResponse.json({ error: DISPATCHED_MESSAGE }, { status: 409 })
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
    if (message.includes("ORDER_ALREADY_CANCELLED")) {
      return NextResponse.json(
        { error: "La compra ya está cancelada." },
        { status: 409 },
      )
    }
    if (message.includes("ORDER_ALREADY_DISPATCHED")) {
      return NextResponse.json(
        { error: "Tu pedido ya fue despachado y no puede cancelarse en este momento." },
        { status: 409 },
      )
    }
    if (message.includes("ANDREANI_CREATION_IN_PROGRESS")) {
      return NextResponse.json(
        { error: "No podés cancelar mientras se está generando el envío. Probá de nuevo en unos minutos." },
        { status: 409 },
      )
    }
    if (message.includes("ANDREANI_RECONCILIATION_REQUIRED")) {
      return NextResponse.json(
        { error: "El envío necesita revisión antes de poder cancelar. Escribinos para resolverlo." },
        { status: 409 },
      )
    }
    // Error desconocido: nunca se expone al cliente, pero se registra
    // completo (código/detalle de Postgres) para poder diagnosticarlo -- sin
    // este log, un bug real en la RPC es indistinguible de un simple
    // rechazo de negocio.
    console.error(
      "Cancelación de compra: error no reconocido en request_customer_order_cancellation_with_claim",
      { orderId: order.id, code: cancellationError?.code, message, details: cancellationError?.details, hint: cancellationError?.hint },
    )
    return NextResponse.json(
      { error: "No se pudo cancelar la compra de forma segura." },
      { status: 500 },
    )
  }

  const updatedOrder = cancellationResult as unknown as CancelableOrder
  const nextFinancialStatus = updatedOrder.financial_status ?? "cancelled"

  await emailCustomerCancellation(updatedOrder)
  return NextResponse.json({
    order: toCustomerCancellationOrderView(updatedOrder),
    message:
      nextFinancialStatus === "refund_pending"
        ? "Recibimos la cancelación de tu pedido. Te avisamos cuando el reintegro esté listo."
        : "Recibimos la cancelación de tu pedido.",
  })
}
