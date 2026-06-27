import { NextResponse } from "next/server"

import { sendOrderStatusEmail } from "@/lib/email/send-order-status-email"
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

function isMissingColumnError(error: { message?: string; code?: string } | null) {
  return (
    error?.code === "PGRST204" ||
    error?.message?.includes("schema cache") ||
    error?.message?.includes("cancelled_at")
  )
}

function buildCancellationUpdate(includeCancelledAt: boolean, cancelledAt: string) {
  return includeCancelledAt
    ? { estado: "cancelado", cancelled_at: cancelledAt }
    : { estado: "cancelado" }
}

async function notifyCustomerCancellation(
  admin: ReturnType<typeof createAdminClient>,
  order: CancelableOrder,
) {
  const orderCode = getOrderCode(order.id)

  if (order.usuario_id) {
    try {
      const { error } = await admin.from("customer_notifications").upsert({
        user_id: order.usuario_id,
        type: "order_cancelled",
        title: "Compra cancelada",
        body: `Tu compra ${orderCode} fue cancelada correctamente.`,
        action_url: `/cuenta/compras/${order.id}`,
        order_id: order.id,
        source_key: `order:${order.id}:cancelled`,
      }, { onConflict: "source_key" })

      if (error && error.code !== "23505") {
        console.log("No se pudo crear notificación de cancelación", error.message)
      }
    } catch (notificationError) {
      console.log("No se pudo crear notificación de cancelación", notificationError)
    }
  }

  try {
    await sendOrderStatusEmail({
      to: order.cliente_email,
      subject: "Tu compra fue cancelada correctamente",
      html: `
        <h1>Compra cancelada</h1>
        <p>Hola, te confirmamos que tu compra ${orderCode} fue cancelada correctamente.</p>
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
    .select("id, usuario_id, cliente_email, cliente_nombre, estado, tracking_number, andreani_tracking, andreani_envio_id, andreani_estado, delivered_at, invoice_status, invoice_cae, invoice_number, invoice_point, payment_status, payment_proof_url, payment_proof_uploaded_at, paid_at")
    .eq("id", orderId)
    .maybeSingle()

  if (orderError || !order) {
    return NextResponse.json({ error: "No encontramos el pedido." }, { status: 404 })
  }

  if (order.usuario_id !== user.id) {
    return NextResponse.json({ error: "No autorizado." }, { status: 403 })
  }

  if ((order.estado ?? "").toLowerCase() === "cancelado") {
    return NextResponse.json(
      { error: "La compra ya está cancelada." },
      { status: 409 },
    )
  }

  if (isOrderDelivered(order) || isOrderDispatched(order) || isOrderInvoiced(order)) {
    return NextResponse.json(
      { error: "Esta compra ya no se puede cancelar desde la cuenta." },
      { status: 409 },
    )
  }

  const cancelledAt = new Date().toISOString()
  let { data: updatedOrder, error: updateError } = await admin
    .from("ordenes")
    .update(buildCancellationUpdate(true, cancelledAt))
    .eq("id", order.id)
    .not("estado", "in", "(cancelado,enviado,en_camino,entregado)")
    .is("tracking_number", null)
    .is("andreani_tracking", null)
    .is("andreani_envio_id", null)
    .is("invoice_cae", null)
    .is("invoice_number", null)
    .is("invoice_point", null)
    .or("invoice_status.is.null,invoice_status.eq.pending,invoice_status.eq.error")
    .select("*")
    .maybeSingle()

  if (isMissingColumnError(updateError)) {
    console.log("cancelled_at no disponible en ordenes; reintentando cancelación sin timestamp", updateError?.message)
    const retryResult = await admin
      .from("ordenes")
      .update(buildCancellationUpdate(false, cancelledAt))
      .eq("id", order.id)
      .not("estado", "in", "(cancelado,enviado,en_camino,entregado)")
      .is("tracking_number", null)
      .is("andreani_tracking", null)
      .is("andreani_envio_id", null)
      .is("invoice_cae", null)
      .is("invoice_number", null)
      .is("invoice_point", null)
      .or("invoice_status.is.null,invoice_status.eq.pending,invoice_status.eq.error")
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

  return NextResponse.json({
    order: updatedOrder,
    message: "Tu compra fue cancelada correctamente.",
  })
}
