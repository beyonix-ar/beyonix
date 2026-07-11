import { NextResponse } from "next/server"

import { requireOperator } from "@/app/api/admin/clientes/_auth"
import { sendOrderStatusEmail } from "@/lib/email/send-order-status-email"
import { appendOrderAuditEvent } from "@/lib/orders/order-audit"
import {
  DEFAULT_PRODUCT_WARRANTY_MONTHS,
  getWarrantyExpiration,
} from "@/lib/orders/warranty"
import type { createAdminClient } from "@/lib/supabase/admin"

type AdminClient = ReturnType<typeof createAdminClient>

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

function isPaymentConfirmed(order: {
  payment_status?: string | null
  paid_at?: string | null
  estado?: string | null
}) {
  return (
    Boolean(order.paid_at) ||
    ["confirmado", "approved", "confirmed"].includes(order.payment_status ?? "") ||
    ["pagado", "enviado", "en_camino", "entregado"].includes(order.estado ?? "")
  )
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

async function activatePendingItemWarranties(
  admin: AdminClient,
  {
    orderId,
    deliveredAt,
    actorId,
  }: {
    orderId: number
    deliveredAt: string
    actorId: string
  },
) {
  const { data: items, error: itemsError } = await admin
    .from("orden_items")
    .select("id, warranty_started_at, warranty_expires_at, warranty_status, warranty_months")
    .eq("orden_id", orderId)

  if (itemsError) {
    console.warn("ORDER_WARRANTY_ITEMS_ERROR", {
      orderId,
      message: itemsError.message,
    })
    return
  }

  const pendingItems = (items ?? []).filter(
    (item) =>
      !item.warranty_started_at &&
      !item.warranty_expires_at &&
      (item.warranty_status === null ||
        item.warranty_status === undefined ||
        item.warranty_status === "pending_delivery"),
  )

  if (!pendingItems.length) return

  const previousByItemId = Object.fromEntries(
    pendingItems.map((item) => [
      item.id,
      {
        warranty_started_at: item.warranty_started_at,
        warranty_expires_at: item.warranty_expires_at,
        warranty_months: item.warranty_months,
        warranty_status: item.warranty_status,
      },
    ]),
  )

  const updates = pendingItems.map((item) => {
    const months =
      typeof item.warranty_months === "number" && item.warranty_months > 0
        ? item.warranty_months
        : DEFAULT_PRODUCT_WARRANTY_MONTHS

    return {
      id: item.id,
      warranty_started_at: deliveredAt,
      warranty_expires_at: getWarrantyExpiration(deliveredAt, months),
      warranty_months: months,
      warranty_status: "active",
    }
  })

  for (const update of updates) {
    const { error } = await admin
      .from("orden_items")
      .update({
        warranty_started_at: update.warranty_started_at,
        warranty_expires_at: update.warranty_expires_at,
        warranty_months: update.warranty_months,
        warranty_status: update.warranty_status,
      })
      .eq("id", update.id)
      .is("warranty_started_at", null)
      .is("warranty_expires_at", null)

    if (error) {
      console.warn("ORDER_WARRANTY_ACTIVATION_ERROR", {
        orderId,
        itemId: update.id,
        message: error.message,
      })
    }
  }

  await appendOrderAuditEvent(admin, {
    orderId,
    actorType: "admin",
    actorId,
    action: "order_item_warranty_started",
    previousStatus: "pending_delivery",
    newStatus: "active",
    metadata: {
      delivered_at: deliveredAt,
      previous: previousByItemId,
      next: updates,
    },
  })
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
    .select("id, estado, delivered_at, payment_status, paid_at, financial_status, order_change_status, invoice_status, invoice_cae, invoice_number, invoice_point")
    .eq("id", orderId)
    .maybeSingle()

  if (currentOrderError || !currentOrder) {
    return NextResponse.json(
      { error: "No encontramos el pedido." },
      { status: 404 },
    )
  }

  if (["enviado", "en_camino", "entregado"].includes(estado)) {
    if (
      ["cancelled", "cancellation_requested", "refund_pending", "refunded"].includes(
        String(currentOrder.financial_status ?? ""),
      )
    ) {
      return NextResponse.json(
        { error: "No se puede despachar un pedido cancelado o con reintegro pendiente." },
        { status: 409 },
      )
    }

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

  const cancellingPaidOrder =
    estado === "cancelado" && isPaymentConfirmed(currentOrder)
  const nextFinancialStatus =
    estado === "cancelado"
      ? cancellingPaidOrder
        ? "refund_pending"
        : "cancelled"
      : currentOrder.financial_status

  const statusUpdate = {
    estado,
    ...(currentOrder.estado !== estado && estado === "cancelado"
      ? { cancelled_at: new Date().toISOString() }
      : {}),
    ...(estado === "cancelado"
      ? {
          financial_status: nextFinancialStatus,
          cancellation_requested_at: new Date().toISOString(),
          cancellation_requested_by: auth.user.id,
          ...(cancellingPaidOrder
            ? {
                refund_pending_at: new Date().toISOString(),
                credit_note_required: isOrderInvoiced(currentOrder),
              }
            : {
                credit_note_required: false,
              }),
        }
      : {}),
    ...(estado === "entregado" && !currentOrder.delivered_at
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
    if (estado === "entregado" && data.delivered_at) {
      await activatePendingItemWarranties(auth.admin, {
        orderId,
        deliveredAt: data.delivered_at,
        actorId: auth.user.id,
      })
    }

    await appendOrderAuditEvent(auth.admin, {
      orderId,
      actorType: "admin",
      actorId: auth.user.id,
      action:
        estado === "cancelado" && cancellingPaidOrder
          ? "order_cancelled_refund_pending"
          : "order_status_changed",
      previousStatus: currentOrder.financial_status ?? currentOrder.estado,
      newStatus: nextFinancialStatus ?? estado,
      metadata: {
        previousEstado: currentOrder.estado,
        newEstado: estado,
      },
    })

    await sendOrderStateEmail(data)
  }

  return NextResponse.json({ order: data })
}
