import { NextResponse } from "next/server"

import { requireAdmin } from "@/app/api/admin/clientes/_auth"
import type { AdminApiAuth } from "@/lib/auth/admin-api"
import {
  describeTestOrderBlockers,
  isTestOrderConfirmationValid,
  isTestOrderReasonValid,
  normalizeTestOrderReason,
  parseTestOrderRestockPlan,
  testOrderConfirmationText,
} from "@/lib/orders/test-order-classification"

export const runtime = "nodejs"

const ERRORS: Record<string, { status: number; message: string }> = {
  ORDER_TEST_FORBIDDEN: { status: 403, message: "Sólo un super administrador puede clasificar compras de prueba." },
  ORDER_TEST_REASON_REQUIRED: { status: 400, message: "Indicá el motivo (entre 10 y 500 caracteres)." },
  ORDER_TEST_CONFIRMATION_MISMATCH: { status: 400, message: "Escribí el número del pedido para confirmar." },
  ORDER_TEST_RESTOCK_CHOICE_REQUIRED: { status: 400, message: "Indicá si querés reingresar las unidades al stock." },
  ORDER_TEST_RESTOCK_UNSUPPORTED: { status: 409, message: "Este pedido tiene artículos que no se pueden reingresar automáticamente. Clasificalo sin reingresar stock y corregilo desde Productos." },
  ORDER_TEST_STOCK_ALREADY_RESTORED: { status: 409, message: "Las unidades de este pedido ya se reingresaron al stock." },
  ORDER_NOT_FOUND: { status: 404, message: "El pedido no existe." },
}

type Access = { ok: false; response: Response } | { ok: true; auth: AdminApiAuth; orderId: number }

async function authorize(request: Request, params: Promise<{ id: string }>): Promise<Access> {
  const auth = await requireAdmin(request)
  if ("error" in auth) return { ok: false, response: auth.error }
  if (auth.profile.rol !== "super_admin") {
    return { ok: false, response: NextResponse.json({ error: ERRORS.ORDER_TEST_FORBIDDEN.message }, { status: 403 }) }
  }
  const orderId = Number((await params).id)
  if (!Number.isSafeInteger(orderId) || orderId <= 0) {
    return { ok: false, response: NextResponse.json({ error: "Pedido inválido." }, { status: 400 }) }
  }
  return { ok: true, auth, orderId }
}

function rpcErrorResponse(message: string | undefined) {
  const blocked = /ORDER_TEST_BLOCKED:([a-z_,]+)/.exec(message ?? "")
  if (blocked) {
    const codes = blocked[1].split(",").filter(Boolean)
    return NextResponse.json(
      { error: "No se puede clasificar este pedido como prueba.", blockers: codes, reasons: describeTestOrderBlockers(codes) },
      { status: 409 },
    )
  }
  const known = Object.entries(ERRORS).find(([code]) => message?.includes(code))?.[1]
  return NextResponse.json(
    { error: known?.message ?? "No se pudo clasificar el pedido como prueba." },
    { status: known?.status ?? 500 },
  )
}

/** Vista previa: bloqueos y unidades que se reingresarían. Sólo lectura. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const access = await authorize(request, params)
  if (!access.ok) return access.response
  const [blockersResult, planResult] = await Promise.all([
    access.auth.admin.rpc("order_test_classification_blockers", { p_order_id: access.orderId }),
    access.auth.admin.rpc("order_test_restock_plan", { p_order_id: access.orderId }),
  ])
  const plan = parseTestOrderRestockPlan(planResult.data)
  if (blockersResult.error || planResult.error || !Array.isArray(blockersResult.data) || !plan) {
    console.error("ORDER_TEST_PREVIEW_ERROR", {
      orderId: access.orderId,
      message: blockersResult.error?.message ?? planResult.error?.message ?? "invalid_payload",
    })
    return NextResponse.json({ error: "No se pudo comprobar si el pedido se puede clasificar como prueba." }, { status: 500 })
  }
  const codes = blockersResult.data.filter((code): code is string => typeof code === "string")
  return NextResponse.json({
    blockers: codes,
    reasons: describeTestOrderBlockers(codes),
    restockPlan: plan,
    confirmation: testOrderConfirmationText(access.orderId),
  })
}

/**
 * Clasifica una compra interna como prueba: queda fuera de las estadísticas
 * comerciales, se archiva y, si se pide, reingresa al stock las unidades
 * pendientes. No toca pago, factura ni NC. La base revalida todo en una sola
 * transacción y deja la auditoría; un reintento no repite nada.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const access = await authorize(request, params)
  if (!access.ok) return access.response
  let body: { reason?: unknown; confirmation?: unknown; restock?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: "Solicitud inválida." }, { status: 400 })
  }
  const reason = normalizeTestOrderReason(body.reason)
  if (!isTestOrderReasonValid(reason)) {
    return NextResponse.json({ error: ERRORS.ORDER_TEST_REASON_REQUIRED.message }, { status: 400 })
  }
  const confirmation = typeof body.confirmation === "string" ? body.confirmation : ""
  if (!isTestOrderConfirmationValid(access.orderId, confirmation)) {
    return NextResponse.json({ error: ERRORS.ORDER_TEST_CONFIRMATION_MISMATCH.message }, { status: 400 })
  }
  if (typeof body.restock !== "boolean") {
    return NextResponse.json({ error: ERRORS.ORDER_TEST_RESTOCK_CHOICE_REQUIRED.message }, { status: 400 })
  }
  const { data, error } = await access.auth.admin.rpc("classify_test_order_admin", {
    p_order_id: access.orderId,
    p_actor: access.auth.user.id,
    p_reason: reason,
    p_confirmation: confirmation,
    p_restock: body.restock,
  })
  if (error) {
    console.error("ORDER_TEST_CLASSIFICATION_ERROR", { orderId: access.orderId, message: error.message })
    return rpcErrorResponse(error.message)
  }
  return NextResponse.json({ classification: data })
}
