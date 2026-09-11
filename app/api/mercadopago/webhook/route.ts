import { NextResponse } from "next/server"

import { reverseCustomerCreditForOrder } from "@/lib/customer-credit/server"
import { sendOrderStatusEmail } from "@/lib/email/send-order-status-email"
import {
  getMercadoPagoPayment,
  processCustomerCreditTopupPayment,
} from "@/lib/mercadopago/customer-credit-topups"
import {
  isInventoryConfirmationConflict,
  isMercadoPagoOrderAlreadyConfirmed,
  isMercadoPagoOrderCancelled,
  MERCADOPAGO_APPROVED_AFTER_CANCELLATION_STATUS,
  MERCADOPAGO_STOCK_CONFLICT_PAYMENT_STATUS,
  MercadoPagoInventoryConflictError,
  processApprovedMercadoPagoOrderPayment,
} from "@/lib/mercadopago/order-payment"
import { reconcileMercadoPagoOrderRefund } from "@/lib/mercadopago/order-refund"
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
  payment_id?: string | null
  payment_status?: string | null
}

/**
 * Estados que Mercado Pago notifica DESPUÉS de que un pago ya fue aprobado y
 * confirmado -- nunca en la aprobación original. Sin esto, cualquier webhook
 * posterior a la confirmación caía en el "ya confirmado -> duplicado" de
 * abajo y una notificación real de reintegro/contracargo se descartaba en
 * silencio (la UI de Admin ya tiene label/tono para "charged_back" -- nunca
 * llegaba a setearse).
 */
const POST_CONFIRMATION_REVERSAL_STATUSES = new Set(["refunded", "charged_back"])

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
      .select("id, estado, total, external_amount_due, credit_balance_used, cliente_email, cliente_nombre, financial_status, payment_method_id, payment_id, payment_status")
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
      // La orden ya se confirmó -- pero un reintegro/contracargo NOTIFICADO
      // por Mercado Pago sobre ESE MISMO pago tiene que quedar registrado
      // igual: el dinero ya salió de la cuenta de BEYONIX aunque el pedido
      // siga marcado como pagado. Nunca se toca stock/saldo/envío acá (eso
      // requiere criterio humano, igual que approved_stock_conflict) -- sólo
      // se deja visible y auditado para resolución manual.
      if (
        POST_CONFIRMATION_REVERSAL_STATUSES.has(payment.status) &&
        orderRow.payment_id === String(payment.id) &&
        orderRow.payment_status !== payment.status
      ) {
        const { data: reversalUpdated, error: reversalError } = await supabase
          .from("ordenes")
          .update({ payment_status: payment.status } as never)
          .eq("id", orderId)
          .eq("payment_id", String(payment.id))
          .neq("payment_status", payment.status)
          .select("id")
          .maybeSingle()

        if (reversalError) {
          console.error("MERCADOPAGO_POST_CONFIRMATION_REVERSAL_PERSIST_ERROR", {
            orderId,
            paymentId: payment.id,
            paymentStatus: payment.status,
            message: reversalError.message,
          })
        } else if (reversalUpdated) {
          await appendOrderAuditEvent(supabase, {
            orderId,
            actorType: "system",
            action:
              payment.status === "charged_back"
                ? "payment_charged_back"
                : "payment_refunded_by_provider",
            previousStatus: orderRow.financial_status ?? "payment_confirmed",
            newStatus: orderRow.financial_status ?? "payment_confirmed",
            metadata: {
              provider: "mercadopago",
              paymentId: payment.id,
              paymentStatus: payment.status,
              reason: "post_confirmation_reversal_notified_by_provider",
            },
          })
          console.error("MERCADOPAGO_POST_CONFIRMATION_REVERSAL", {
            orderId,
            paymentId: payment.id,
            paymentStatus: payment.status,
          })

          // FASE 2: integra con mercadopago_order_refunds -- nunca inventa
          // una operación. Sin debilitar nada de arriba (firma/replay/
          // reconsulta/ARS/monto/ownership ya se validaron antes de llegar
          // acá): esto sólo decide qué hacer con una notificación de
          // reversa ya autenticada y ya persistida.
          if (payment.status === "charged_back") {
            // Un contracargo es siempre un incidente adversarial -- nunca se
            // reconcilia como si fuera un refund cooperativo iniciado por
            // BEYONIX, y nunca toca financial_status automáticamente.
            await appendOrderAuditEvent(supabase, {
              orderId,
              actorType: "system",
              action: "mp_chargeback_detected",
              previousStatus: orderRow.financial_status ?? "payment_confirmed",
              newStatus: orderRow.financial_status ?? "payment_confirmed",
              metadata: {
                paymentId: payment.id,
                reason: "chargeback_requires_manual_resolution",
              },
            })
          } else {
            // payment.status === "refunded": si hay un intento nuestro en
            // curso, esta notificación es la señal para reconciliarlo (GET,
            // nunca un nuevo POST) -- reconcileMercadoPagoOrderRefund ya
            // cierra el claim automáticamente si confirma. Si NO hay ningún
            // intento nuestro, es un refund externo (hecho a mano en el
            // dashboard de Mercado Pago, fuera de BEYONIX) -- se audita como
            // incidente visible, sin inventar ni completar ninguna operación.
            const { data: pendingAttempt } = await supabase
              .from("mercadopago_order_refunds")
              .select("id")
              .eq("order_id", orderId)
              .in("status", ["processing", "needs_reconciliation"])
              .limit(1)
              .maybeSingle()

            if (pendingAttempt) {
              await reconcileMercadoPagoOrderRefund(supabase, { orderId })
            } else {
              await appendOrderAuditEvent(supabase, {
                orderId,
                actorType: "system",
                action: "mp_external_refund_detected",
                previousStatus: orderRow.financial_status ?? "payment_confirmed",
                newStatus: orderRow.financial_status ?? "payment_confirmed",
                metadata: {
                  paymentId: payment.id,
                  reason: "refund_not_initiated_by_beyonix",
                },
              })
            }
          }
        }
      }

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

    // P1: una orden cancelada (checkout expirado, cancelación de cliente o de
    // admin) es un estado terminal -- un pago aprobado tardío sobre la MISMA
    // preferencia (reintento con otra tarjeta en Checkout Pro, o simple
    // latencia del webhook) NUNCA la resucita a pagada. El dinero es real: se
    // registra en auditoría para reconciliación manual, sin tocar
    // estado/financial_status/stock. isMercadoPagoOrderAlreadyConfirmed() no
    // cubre este caso porque la orden nunca llegó a confirmarse.
    if (payment.status === "approved" && isMercadoPagoOrderCancelled(orderRow)) {
      const { data: lateUpdatedOrder, error: lateUpdateError } = await supabase
        .from("ordenes")
        .update({
          ...paymentPayload,
          payment_status: MERCADOPAGO_APPROVED_AFTER_CANCELLATION_STATUS,
        } as never)
        .eq("id", orderId)
        .eq("estado", "cancelado")
        .neq("payment_status", MERCADOPAGO_APPROVED_AFTER_CANCELLATION_STATUS)
        .select("id")
        .maybeSingle()

      if (lateUpdateError) {
        console.error("MERCADOPAGO_APPROVED_AFTER_CANCELLATION_PERSIST_ERROR", {
          orderId,
          paymentId: payment.id,
          message: lateUpdateError.message,
        })
        throw lateUpdateError
      }

      if (lateUpdatedOrder) {
        await appendOrderAuditEvent(supabase, {
          orderId,
          actorType: "system",
          action: "payment_approved_after_cancellation",
          previousStatus: orderRow.financial_status ?? "cancelled",
          newStatus: orderRow.financial_status ?? "cancelled",
          metadata: {
            provider: "mercadopago",
            paymentId: payment.id,
            paymentStatus: payment.status,
            transactionAmount: payment.transaction_amount ?? null,
            reason: "order_already_cancelled_requires_manual_reconciliation",
          },
        })
        console.error("MERCADOPAGO_APPROVED_PAYMENT_AFTER_CANCELLATION", {
          orderId,
          paymentId: payment.id,
        })
      }

      // 200 a propósito, igual que approved_stock_conflict: reintentar el
      // mismo webhook no lo va a resolver, necesita criterio humano.
      return NextResponse.json({
        ok: true,
        paymentConfirmed: false,
        reason: "order_already_cancelled",
      })
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

    let paymentResult
    try {
      paymentResult = await processApprovedMercadoPagoOrderPayment(
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

        if (updateError) {
          // El pago YA ocurrió: si el guardián de inventario rechaza la
          // confirmación (la reserva venció y otro checkout se llevó las
          // unidades), reintentar no lo arregla. Se distingue del resto de
          // los errores de base para marcarlo y frenar los reintentos de MP.
          if (isInventoryConfirmationConflict(updateError)) {
            throw new MercadoPagoInventoryConflictError(updateError)
          }
          throw updateError
        }
        return updatedOrders?.length === 1
      },
      )
    } catch (confirmationError) {
      if (!(confirmationError instanceof MercadoPagoInventoryConflictError)) {
        throw confirmationError
      }

      // El dinero YA está aprobado: si esta escritura falla (por ejemplo, un
      // constraint de la base que rechace el nuevo payment_status), no puede
      // quedar en silencio -- perderíamos la única evidencia persistida de
      // que hay un pago aprobado sin poder cumplirse.
      const { error: stockConflictUpdateError } = await supabase
        .from("ordenes")
        .update({
          ...paymentPayload,
          payment_status: MERCADOPAGO_STOCK_CONFLICT_PAYMENT_STATUS,
        } as never)
        .eq("id", orderId)
        .eq("estado", orderRow.estado)
        .eq("financial_status", orderRow.financial_status ?? "pending_payment")

      if (stockConflictUpdateError) {
        console.error("MERCADOPAGO_APPROVED_PAYMENT_STOCK_CONFLICT_PERSIST_ERROR", {
          orderId,
          paymentId: payment.id,
          message: stockConflictUpdateError.message,
        })
        throw stockConflictUpdateError
      }

      await appendOrderAuditEvent(supabase, {
        orderId,
        actorType: "system",
        action: "payment_approved_stock_conflict",
        previousStatus: orderRow.financial_status ?? "pending_payment",
        newStatus: MERCADOPAGO_STOCK_CONFLICT_PAYMENT_STATUS,
        metadata: {
          provider: "mercadopago",
          paymentId: payment.id,
          paymentStatus: payment.status,
          reason: "inventory_unavailable_at_confirmation",
        },
      })

      console.error("MERCADOPAGO_APPROVED_PAYMENT_STOCK_CONFLICT", {
        orderId,
        paymentId: payment.id,
      })

      // 200 a propósito: el pago se registró y quedó marcado para resolución
      // manual. Devolver 500 sólo haría que Mercado Pago reintente un webhook
      // que nunca va a poder confirmarse.
      return NextResponse.json({
        ok: true,
        paymentConfirmed: false,
        reason: "stock_conflict",
      })
    }

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
