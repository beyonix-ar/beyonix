import { NextResponse } from "next/server"

import { requireOperator } from "@/app/api/admin/clientes/_auth"
import { sendOrderStatusEmail } from "@/lib/email/send-order-status-email"

const ALLOWED_ORDER_STATUSES = [
  "pendiente",
  "pagado",
  "enviado",
  "en_camino",
  "entregado",
  "cancelado",
]

function normalizeExternalUrl(value: unknown) {
  if (typeof value !== "string") return null

  const trimmed = value.trim()
  if (!trimmed) return null

  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

function getOrderCode(orderId: number) {
  return `BX-${1000 + orderId}`
}

function isMissingColumnError(error: { message?: string; code?: string } | null) {
  return (
    error?.code === "PGRST204" ||
    error?.message?.includes("schema cache") ||
    error?.message?.includes("cancelled_at")
  )
}

async function sendOrderStateEmail(order: {
  id: number
  estado?: string | null
  cliente_email?: string | null
  cliente_nombre?: string | null
  tracking_number?: string | null
  tracking_url?: string | null
}) {
  const orderCode = getOrderCode(order.id)

  if (order.estado === "enviado" || order.estado === "en_camino") {
    await sendOrderStatusEmail({
      to: order.cliente_email,
      subject: `Pedido enviado ${orderCode}`,
      html: `
        <h1>Pedido enviado</h1>
        <p>Hola ${order.cliente_nombre ?? ""}, tu pedido ${orderCode} ya fue enviado.</p>
        ${order.tracking_number ? `<p>Seguimiento: ${order.tracking_number}</p>` : ""}
        ${order.tracking_url ? `<p><a href="${order.tracking_url}">Ver seguimiento</a></p>` : ""}
      `,
    })
    return
  }

  if (order.estado === "entregado") {
    await sendOrderStatusEmail({
      to: order.cliente_email,
      subject: `Pedido entregado ${orderCode}`,
      html: `
        <h1>Pedido entregado</h1>
        <p>Hola ${order.cliente_nombre ?? ""}, tu pedido ${orderCode} figura como entregado.</p>
        <p>Si necesitás ayuda con la compra, podés iniciar un reclamo desde tu cuenta.</p>
      `,
    })
    return
  }

  if (order.estado === "cancelado") {
    await sendOrderStatusEmail({
      to: order.cliente_email,
      subject: `Compra cancelada ${orderCode}`,
      html: `
        <h1>Compra cancelada</h1>
        <p>Hola ${order.cliente_nombre ?? ""}, tu pedido ${orderCode} fue cancelado.</p>
        <p>Te avisaremos cualquier novedad adicional desde tu cuenta y por email.</p>
      `,
    })
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireOperator(request)

  if ("error" in auth) return auth.error

  const { id } = await params
  const orderId = Number(id)
  const body = (await request.json()) as {
    estado?: unknown
    tracking_number?: unknown
    tracking_url?: unknown
  }
  const estado = String(body.estado ?? "")

  if (!Number.isFinite(orderId) || orderId <= 0) {
    return NextResponse.json({ error: "Pedido inválido." }, { status: 400 })
  }

  if (!ALLOWED_ORDER_STATUSES.includes(estado)) {
    return NextResponse.json(
      { error: "Estado del pedido inválido." },
      { status: 400 },
    )
  }

  const trackingNumber =
    typeof body.tracking_number === "string"
      ? body.tracking_number.trim() || null
      : null

  const { data: currentOrder, error: currentOrderError } = await auth.admin
    .from("ordenes")
    .select("id, estado, order_change_status")
    .eq("id", orderId)
    .maybeSingle()

  if (currentOrderError || !currentOrder) {
    return NextResponse.json(
      { error: "No encontramos el pedido." },
      { status: 404 },
    )
  }

  if (["enviado", "en_camino", "entregado"].includes(estado)) {
    if (currentOrder.order_change_status === "change_requested") {
      return NextResponse.json(
        { error: "No se puede despachar un pedido con cambio pendiente de aprobación." },
        { status: 409 },
      )
    }

    if (currentOrder.order_change_status === "extra_payment_pending") {
      return NextResponse.json(
        { error: "No se puede despachar un pedido con diferencia de cambio pendiente de pago." },
        { status: 409 },
      )
    }
  }

  const statusUpdate = {
    estado,
    ...(currentOrder.estado !== estado && estado === "cancelado"
      ? { cancelled_at: new Date().toISOString() }
      : {}),
    ...(estado === "entregado"
      ? { delivered_at: new Date().toISOString() }
      : {}),
    ...(body.tracking_number !== undefined
      ? { tracking_number: trackingNumber }
      : {}),
    ...(body.tracking_url !== undefined
      ? { tracking_url: normalizeExternalUrl(body.tracking_url) }
      : {}),
  }
  let { data, error } = await auth.admin
    .from("ordenes")
    .update(statusUpdate)
    .eq("id", orderId)
    .select()
    .single()

  if (isMissingColumnError(error) && "cancelled_at" in statusUpdate) {
    const fallbackUpdate = { ...statusUpdate }
    delete (fallbackUpdate as { cancelled_at?: string }).cancelled_at
    const retryResult = await auth.admin
      .from("ordenes")
      .update(fallbackUpdate)
      .eq("id", orderId)
      .select()
      .single()

    data = retryResult.data
    error = retryResult.error
  }

  if (error || !data) {
    return NextResponse.json(
      { error: error?.message || "No se pudo actualizar el estado del pedido." },
      { status: 500 },
    )
  }

  if (currentOrder.estado !== estado) {
    await sendOrderStateEmail(data)
  }

  return NextResponse.json({ order: data })
}
