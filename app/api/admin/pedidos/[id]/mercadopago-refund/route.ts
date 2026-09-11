import { NextResponse } from "next/server"

import { requireAdmin } from "@/app/api/admin/clientes/_auth"
import {
  reconcileMercadoPagoOrderRefund,
  refundMercadoPagoOrderPayment,
} from "@/lib/mercadopago/order-refund"

/**
 * Refund REAL contra Mercado Pago (FASE 1). Sólo admin/super_admin
 * (requireAdmin, nunca operador). Nunca acepta un monto del body -- el monto
 * lo calcula begin_mercadopago_order_refund server-side a partir de
 * ordenes.payment_confirmed_amount.
 *
 * Idempotente: reintentar este POST sobre el mismo pedido nunca dispara un
 * segundo refund -- si ya hay un intento activo/confirmado,
 * refundMercadoPagoOrderPayment lo detecta y no vuelve a llamar a Mercado
 * Pago (ver begin_mercadopago_order_refund).
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(request)
  if ("error" in auth) return auth.error

  const orderId = Number((await params).id)
  if (!Number.isSafeInteger(orderId) || orderId <= 0) {
    return NextResponse.json({ error: "Pedido inválido." }, { status: 400 })
  }

  const result = await refundMercadoPagoOrderPayment(auth.admin, {
    orderId,
    adminId: auth.user.id,
  })

  switch (result.kind) {
    case "confirmed":
      return NextResponse.json({
        ok: true,
        status: "confirmed",
        mpRefundId: result.mpRefundId,
        amount: result.amount,
      })
    case "already_confirmed":
      return NextResponse.json({ ok: true, status: "already_confirmed" })
    case "in_progress":
      return NextResponse.json(
        { ok: false, status: result.status, error: "El refund ya está en curso." },
        { status: 409 },
      )
    case "rejected":
      return NextResponse.json(
        { ok: false, status: "failed", error: result.message, code: result.code },
        { status: 409 },
      )
    case "unknown":
      return NextResponse.json(
        {
          ok: false,
          status: "needs_reconciliation",
          error: "Mercado Pago no confirmó el resultado del refund. Requiere reconciliación antes de reintentar.",
        },
        { status: 202 },
      )
    case "validation_failed":
      return NextResponse.json(
        { ok: false, error: "No se pudo validar el refund.", reason: result.reason },
        { status: 409 },
      )
  }
}

/**
 * Reconcilia un intento ambiguo ('processing'/'needs_reconciliation') contra
 * el estado real en Mercado Pago -- NUNCA dispara un nuevo POST de refund.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(request)
  if ("error" in auth) return auth.error

  const orderId = Number((await params).id)
  if (!Number.isSafeInteger(orderId) || orderId <= 0) {
    return NextResponse.json({ error: "Pedido inválido." }, { status: 400 })
  }

  const result = await reconcileMercadoPagoOrderRefund(auth.admin, { orderId })

  switch (result.kind) {
    case "confirmed":
      return NextResponse.json({
        ok: true,
        status: "confirmed",
        mpRefundId: result.mpRefundId,
        amount: result.amount,
      })
    case "not_found_yet":
      return NextResponse.json({
        ok: true,
        status: "requested",
        message: "Mercado Pago no tiene registro del refund; se puede reintentar.",
      })
    case "nothing_to_reconcile":
      return NextResponse.json({ ok: true, status: "nothing_to_reconcile" })
    case "unknown":
      return NextResponse.json(
        { ok: false, status: "needs_reconciliation", error: result.reason },
        { status: 202 },
      )
  }
}
