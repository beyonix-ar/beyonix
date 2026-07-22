import { createHmac, timingSafeEqual } from "node:crypto"

import { NextResponse } from "next/server"

import { reverseCustomerCreditForOrder } from "@/lib/customer-credit/server"
import { sendOrderStatusEmail } from "@/lib/email/send-order-status-email"
import {
  getMercadoPagoPayment,
  processCustomerCreditTopupPayment,
  type MercadoPagoPayment,
} from "@/lib/mercadopago/customer-credit-topups"
import { appendOrderAuditEvent } from "@/lib/orders/order-audit"
import { createAdminClient } from "@/lib/supabase/admin"

interface OrderItemRow {
  producto_id: number
  variante_id: number | null
  cantidad: number
}

interface OrderRow {
  id: number
  estado: string
  total?: number | null
  external_amount_due?: number | null
  credit_balance_used?: number | null
  cliente_email: string | null
  cliente_nombre: string | null
  financial_status?: string | null
}

function getPaymentId(url: URL, body: unknown) {
  const topic = url.searchParams.get("topic") || url.searchParams.get("type")
  const queryId = url.searchParams.get("id") || url.searchParams.get("data.id")

  if (topic === "payment" && queryId) {
    return queryId
  }

  if (body && typeof body === "object") {
    const record = body as {
      type?: string
      topic?: string
      data?: { id?: string | number }
      resource?: string
    }

    if ((record.type === "payment" || record.topic === "payment") && record.data?.id) {
      return String(record.data.id)
    }

    if (record.resource?.includes("/payments/")) {
      return record.resource.split("/").pop() || null
    }
  }

  return null
}

function isValidWebhookSignature(request: Request, paymentId: string) {
  const secret = process.env.MERCADOPAGO_WEBHOOK_SECRET
  if (request.method === "GET") return true
  if (!secret) return process.env.NODE_ENV !== "production"

  const signature = request.headers.get("x-signature")
  const requestId = request.headers.get("x-request-id")
  if (!signature || !requestId) return false

  const parts = new Map(
    signature.split(",").map((part) => {
      const [key, ...value] = part.trim().split("=")
      return [key, value.join("=")]
    }),
  )
  const timestamp = parts.get("ts")
  const receivedHash = parts.get("v1")
  if (!timestamp || !receivedHash) return false

  const manifest = `id:${paymentId.toLowerCase()};request-id:${requestId};ts:${timestamp};`
  const expectedHash = createHmac("sha256", secret)
    .update(manifest)
    .digest("hex")
  const expectedBuffer = Buffer.from(expectedHash)
  const receivedBuffer = Buffer.from(receivedHash)

  return (
    expectedBuffer.length === receivedBuffer.length &&
    timingSafeEqual(expectedBuffer, receivedBuffer)
  )
}

async function decrementStock(orderItems: OrderItemRow[]) {
  const supabase = createAdminClient()

  for (const item of orderItems) {
    if (item.variante_id) {
      const { data: variant, error: variantError } = await supabase
        .from("producto_variantes")
        .select("id, stock")
        .eq("id", item.variante_id)
        .single()

      if (variantError || !variant) {
        throw new Error("No se pudo leer el stock de una variante")
      }

      const { error } = await supabase
        .from("producto_variantes")
        .update({
          stock: Math.max(Number(variant.stock ?? 0) - item.cantidad, 0),
        })
        .eq("id", item.variante_id)

      if (error) throw error
    }

    const { data: product, error: productError } = await supabase
      .from("productos")
      .select("id, stock")
      .eq("id", item.producto_id)
      .single()

    if (productError || !product) {
      throw new Error("No se pudo leer el stock de un producto")
    }

    const { error } = await supabase
      .from("productos")
      .update({
        stock: Math.max(Number(product.stock ?? 0) - item.cantidad, 0),
      })
      .eq("id", item.producto_id)

    if (error) throw error
  }
}

async function handleWebhook(request: Request) {
  try {
    const url = new URL(request.url)
    let body: unknown = null

    try {
      body = await request.json()
    } catch {
      body = null
    }

    const paymentId = getPaymentId(url, body)

    if (!paymentId) {
      return NextResponse.json({ ok: true })
    }

    if (!isValidWebhookSignature(request, paymentId)) {
      return NextResponse.json(
        { error: "Firma de webhook inválida." },
        { status: 401 },
      )
    }

    const payment = await getMercadoPagoPayment(paymentId)

    if (payment.external_reference?.startsWith("credit-topup:")) {
      const result = await processCustomerCreditTopupPayment(payment)
      return NextResponse.json({ ok: true, ...result })
    }

    const orderId = Number(payment.external_reference)

    if (!Number.isFinite(orderId)) {
      console.log("Webhook sin external_reference válido", payment.id)
      return NextResponse.json({ ok: true })
    }

    const supabase = createAdminClient()

    const { data: order, error: orderError } = await supabase
      .from("ordenes")
      .select("id, estado, total, external_amount_due, credit_balance_used, cliente_email, cliente_nombre, financial_status")
      .eq("id", orderId)
      .single()

    if (orderError || !order) {
      throw new Error(`Orden ${orderId} no encontrada`)
    }

    const orderRow = order as OrderRow

    if (orderRow.estado === "pagado") {
      return NextResponse.json({ ok: true, duplicated: true })
    }

    const paymentPayload = {
      payment_id: String(payment.id),
      payment_status: payment.status,
      payment_method_id: "mercadopago",
      payment_type_id:
        payment.payment_method_id ??
        payment.payment_type_id ??
        null,
      paid_at: payment.date_approved ?? null,
    }

    if (payment.status !== "approved") {
      await supabase
        .from("ordenes")
        .update(paymentPayload as never)
        .eq("id", orderId)

      if (
        ["cancelled", "rejected"].includes(payment.status) &&
        Number(orderRow.credit_balance_used ?? 0) > 0
      ) {
        await reverseCustomerCreditForOrder(supabase, {
          orderId,
          description: "Reintegro de saldo por pago rechazado",
        })
      }

      return NextResponse.json({ ok: true })
    }

    const { data: orderItems, error: itemsError } = await supabase
      .from("orden_items")
      .select("producto_id, variante_id, cantidad")
      .eq("orden_id", orderId)

    if (itemsError) {
      throw itemsError
    }

    await decrementStock((orderItems ?? []) as OrderItemRow[])

    const { error: updateError } = await supabase
      .from("ordenes")
      .update({
        ...paymentPayload,
        estado: "pagado",
        financial_status: "payment_confirmed",
        payment_confirmed_at: payment.date_approved ?? new Date().toISOString(),
        payment_confirmed_amount: Number(
          orderRow.external_amount_due ?? orderRow.total ?? 0
        ),
      } as never)
      .eq("id", orderId)

    if (updateError) {
      throw updateError
    }

    await appendOrderAuditEvent(supabase, {
      orderId,
      actorType: "system",
      action: "payment_confirmed",
      previousStatus: orderRow.financial_status ?? "pending_payment",
      newStatus: "payment_confirmed",
      metadata: {
        provider: "mercadopago",
        paymentId: payment.id,
        paymentStatus: payment.status,
      },
    })

    await sendOrderStatusEmail({
      to: orderRow.cliente_email,
      subject: "Recibimos tu pedido en Beyonix",
      html: `
        <h1>Recibimos tu pedido</h1>
        <p>Hola ${orderRow.cliente_nombre ?? ""}, tu pedido fue recibido y está en preparación.</p>
        <p>Cuando sea despachado te vamos a enviar el número o link de seguimiento.</p>
      `,
    })

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error("Error procesando webhook de Mercado Pago", error)
    return NextResponse.json({ error: "Webhook error" }, { status: 500 })
  }
}

export async function POST(request: Request) {
  return handleWebhook(request)
}

export async function GET(request: Request) {
  return handleWebhook(request)
}
