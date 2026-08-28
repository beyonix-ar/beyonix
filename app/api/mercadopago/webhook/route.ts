import { NextResponse } from "next/server"

import { reverseCustomerCreditForOrder } from "@/lib/customer-credit/server"
import { sendOrderStatusEmail } from "@/lib/email/send-order-status-email"
import {
  getMercadoPagoPayment,
  processCustomerCreditTopupPayment,
} from "@/lib/mercadopago/customer-credit-topups"
import {
  isMercadoPagoOrderAlreadyConfirmed,
  processApprovedMercadoPagoOrderPayment,
} from "@/lib/mercadopago/order-payment"
import {
  claimMercadoPagoWebhookDelivery,
  releaseMercadoPagoWebhookDelivery,
} from "@/lib/mercadopago/webhook-replay"
import { validateMercadoPagoWebhookSignature } from "@/lib/mercadopago/webhook-signature"
import { appendOrderAuditEvent } from "@/lib/orders/order-audit"
import { createAdminClient } from "@/lib/supabase/admin"

interface OrderRow {
  id: number
  estado: string
  total?: number | null
  external_amount_due?: number | null
  credit_balance_used?: number | null
  cliente_email: string | null
  cliente_nombre: string | null
  financial_status?: string | null
  payment_method_id?: string | null
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

async function handleWebhook(request: Request) {
  let replayClaim: string | null = null

  try {
    const webhookSecret = process.env.MERCADOPAGO_WEBHOOK_SECRET
    if (!webhookSecret?.trim()) {
      return NextResponse.json(
        { error: "Webhook de Mercado Pago no configurado." },
        { status: 503 },
      )
    }

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

    const signatureValidation = validateMercadoPagoWebhookSignature(
      request,
      paymentId,
      webhookSecret,
    )

    if (!signatureValidation.valid || !signatureValidation.requestId) {
      return NextResponse.json(
        { error: "Firma de webhook inválida." },
        { status: 401 },
      )
    }

    replayClaim = claimMercadoPagoWebhookDelivery(
      paymentId,
      signatureValidation.requestId,
    )
    if (!replayClaim) {
      return NextResponse.json({ ok: true, duplicated: true })
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
      .select("id, estado, total, external_amount_due, credit_balance_used, cliente_email, cliente_nombre, financial_status, payment_method_id")
      .eq("id", orderId)
      .single()

    if (orderError || !order) {
      throw new Error(`Orden ${orderId} no encontrada`)
    }

    const orderRow = order as OrderRow

    if (orderRow.payment_method_id !== "mercadopago") {
      console.warn("Webhook de Mercado Pago para una orden de otro medio", {
        orderId,
        paymentId: payment.id,
        paymentMethodId: orderRow.payment_method_id,
      })
      return NextResponse.json({ ok: true, ignored: true })
    }

    if (isMercadoPagoOrderAlreadyConfirmed(orderRow)) {
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
    }

    if (payment.status !== "approved") {
      await supabase
        .from("ordenes")
        .update(paymentPayload as never)
        .eq("id", orderId)
        .eq("estado", orderRow.estado)
        .eq(
          "financial_status",
          orderRow.financial_status ?? "pending_payment",
        )

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

    const paymentResult = await processApprovedMercadoPagoOrderPayment(
      orderRow,
      payment,
      async (confirmedAmount) => {
        const confirmedAt =
          payment.date_approved ?? new Date().toISOString()
        const { data: updatedOrders, error: updateError } = await supabase
          .from("ordenes")
          .update({
            ...paymentPayload,
            paid_at: confirmedAt,
            estado: "pagado",
            cancelled_at: null,
            financial_status: "payment_confirmed",
            payment_confirmed_at: confirmedAt,
            payment_confirmed_amount: confirmedAmount,
            admin_visible_at: confirmedAt,
            // Costo REAL informado por Mercado Pago (distinto del % configurado
            // usado para armar el precio financiado): se persiste tal cual para
            // poder mostrar a futuro en Admin cliente pagó / costos MP / neto.
            mercadopago_payment_snapshot: {
              installments: payment.installments ?? null,
              transaction_amount: payment.transaction_amount ?? null,
              fee_details: payment.fee_details ?? null,
              transaction_details: payment.transaction_details ?? null,
            },
          } as never)
          .eq("id", orderId)
          .eq("estado", orderRow.estado)
          .eq(
            "financial_status",
            orderRow.financial_status ?? "pending_payment",
          )
          .select("id")

        if (updateError) throw updateError
        return updatedOrders?.length === 1
      },
    )

    if (paymentResult.kind === "duplicate") {
      return NextResponse.json({ ok: true, duplicated: true })
    }

    if (
      paymentResult.kind === "amount_mismatch" ||
      paymentResult.kind === "currency_mismatch"
    ) {
      const mismatchStatus =
        paymentResult.kind === "amount_mismatch"
          ? "approved_amount_mismatch"
          : "approved_currency_mismatch"
      const { error: mismatchUpdateError } = await supabase
        .from("ordenes")
        .update({
          ...paymentPayload,
          payment_status: mismatchStatus,
        } as never)
        .eq("id", orderId)
        .eq("estado", orderRow.estado)
        .eq(
          "financial_status",
          orderRow.financial_status ?? "pending_payment",
        )

      if (mismatchUpdateError) throw mismatchUpdateError

      console.warn("Pago de Mercado Pago no confirmado por discrepancia", {
        orderId,
        paymentId: payment.id,
        result: paymentResult,
      })
      return NextResponse.json({
        ok: true,
        paymentConfirmed: false,
        reason: paymentResult.kind,
      })
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
        confirmedAmount: paymentResult.confirmedAmount,
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
    if (replayClaim) releaseMercadoPagoWebhookDelivery(replayClaim)
    console.error("Error procesando webhook de Mercado Pago", error)
    return NextResponse.json({ error: "Webhook error" }, { status: 500 })
  }
}

export async function POST(request: Request) {
  return handleWebhook(request)
}

export async function GET(request: Request) {
  void request
  return NextResponse.json(
    { error: "Método no permitido. Use Webhooks POST firmados." },
    { status: 405, headers: { Allow: "POST" } },
  )
}
