import { NextResponse } from "next/server"

import { requireAdmin } from "@/app/api/admin/clientes/_auth"
import {
  reconcileMercadoPagoOrderRefund,
} from "@/lib/mercadopago/order-refund"
import { executeFinancialResolution } from "@/lib/orders/financial-resolution-server"

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

  const body = await request.json().catch(() => null) as { confirmed?: boolean } | null
  if (body?.confirmed !== true) return NextResponse.json({ error: "Confirmá el reintegro." }, { status: 400 })
  try {
    const result = await executeFinancialResolution(auth.admin, orderId, auth.user.id,
      request.headers.get("authorization") ?? "", "mercadopago_refund")
    return NextResponse.json({ ok: result.status === "completed", status: result.status,
      error: result.status === "requires_action" ? "Actualización pendiente. Reintentá desde la resolución financiera." : null },
    { status: result.status === "requires_action" ? 202 : 200 })
  } catch (error) {
    const detail = error instanceof Error ? error.message : ""
    return NextResponse.json({ error: /^[A-Z][A-Z_]+/.test(detail) || !detail
      ? "No se pudo ejecutar el reintegro. Revisá el pedido." : detail }, { status: 409 })
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
