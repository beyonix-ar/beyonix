import "server-only"

import { orderCode } from "@/lib/admin/dispatch"
import { localDeliveryServiceDeps, type LocalDeliveryAdminClient } from "@/lib/orders/local-delivery-deps"
import { sendLocalDeliveryOutcomeEmail } from "@/lib/orders/local-delivery-outcome-emails"
import { advanceLocalDelivery } from "@/lib/orders/local-delivery-service"
import { isLocalDeliveryOrder } from "@/lib/shipping/local-delivery"
import { splitDeliveryAddress } from "@/lib/shipping/local-delivery-label"
import {
  COURIER_RESULT_MESSAGES,
  getCourierScreen,
  isLocalDeliveryAccessToken,
  isLocalDeliveryOutcomeStatus,
  type CourierActionRequest,
  type CourierScreen,
} from "@/lib/shipping/local-delivery-outcome"

/**
 * Página del cadete (QR de la etiqueta Envío BEYONIX). Sin login: el token es
 * la única autorización y alcanza SOLO a su pedido. Datos mínimos para
 * entregar: nunca precio, forma de pago, email, DNI/CUIT, saldo, productos ni
 * datos administrativos.
 */
export interface CourierDeliveryView {
  orderCode: string
  customerName: string
  address: string
  reference: string | null
  locality: string
  parcels: number | null
  screen: CourierScreen
  failedAttempts: number
}

const ORDER_COLUMNS = "id,estado,cancelled_at,financial_status,shipping_provider,envio_proveedor,cliente_nombre,cliente_direccion,localidad,cp_destino"
const CANCELLED_FINANCIAL = ["cancellation_requested", "refund_pending", "refunded", "cancelled"]

interface CourierContext {
  orderId: number
  view: CourierDeliveryView
}

/** `null` si el token no existe, fue revocado o no corresponde a un pedido Envío BEYONIX. Lanza si la base falla. */
export async function loadCourierDelivery(admin: LocalDeliveryAdminClient, token: string): Promise<CourierContext | null> {
  if (!isLocalDeliveryAccessToken(token)) return null
  const shipment = await admin.from("local_delivery_shipments")
    .select("id,order_id,shipment_number,outcome_status,failed_attempts")
    .eq("access_token", token).is("token_revoked_at", null).maybeSingle()
  if (shipment.error) throw new Error("COURIER_READ_FAILED")
  const row = shipment.data as { id: number; order_id: number; shipment_number: number; outcome_status: string; failed_attempts: number } | null
  if (!row || !isLocalDeliveryOutcomeStatus(row.outcome_status)) return null
  const [order, newer, pkg] = await Promise.all([
    admin.from("ordenes").select(ORDER_COLUMNS).eq("id", row.order_id).maybeSingle(),
    // Un token de una entrega anterior (nuevo envío) ya no habilita nada.
    admin.from("local_delivery_shipments").select("id").eq("order_id", row.order_id).gt("shipment_number", row.shipment_number).limit(1),
    admin.from("order_packages").select("parcel_count").eq("order_id", row.order_id).maybeSingle(),
  ])
  if (order.error || newer.error || pkg.error) throw new Error("COURIER_READ_FAILED")
  const data = order.data as {
    id: number; estado: string | null; cancelled_at: string | null; financial_status: string | null
    shipping_provider: string | null; envio_proveedor: string | null; cliente_nombre: string | null
    cliente_direccion: string | null; localidad: string | null; cp_destino: string | null
  } | null
  if (!data || !isLocalDeliveryOrder(data) || (newer.data ?? []).length > 0) return null
  const { address, reference } = splitDeliveryAddress(data.cliente_direccion)
  const cancelled = data.estado === "cancelado" || Boolean(data.cancelled_at) || CANCELLED_FINANCIAL.includes(data.financial_status ?? "")
  return {
    orderId: data.id,
    view: {
      orderCode: orderCode(data.id),
      customerName: data.cliente_nombre?.trim() || "—",
      address: address || "—",
      reference,
      locality: [data.localidad?.trim(), data.cp_destino ? `CP ${data.cp_destino.trim()}` : null].filter(Boolean).join(" · "),
      parcels: (pkg.data as { parcel_count: number | null } | null)?.parcel_count ?? null,
      screen: getCourierScreen({ estado: data.estado, cancelled, outcomeStatus: row.outcome_status, failedAttempts: row.failed_attempts }),
      failedAttempts: row.failed_attempts,
    },
  }
}

export interface CourierActionResult {
  status: number
  body: { ok: boolean; result?: string; message: string; view?: CourierDeliveryView }
}

const SCREEN_MESSAGES: Partial<Record<CourierScreen["kind"], string>> = {
  delivered: COURIER_RESULT_MESSAGES.already_delivered,
  cancelled: COURIER_RESULT_MESSAGES.cancelled,
  preparing: COURIER_RESULT_MESSAGES.not_in_transit,
}

async function reply(admin: LocalDeliveryAdminClient, token: string, status: number, ok: boolean, result: string, message: string): Promise<CourierActionResult> {
  const fresh = await loadCourierDelivery(admin, token)
  return { status, body: { ok, result, message, ...(fresh ? { view: fresh.view } : {}) } }
}

/** Ejecuta la acción del cadete. Idempotente: repetirla nunca crea un segundo resultado. */
export async function runCourierAction(admin: LocalDeliveryAdminClient, token: string, request: CourierActionRequest): Promise<CourierActionResult> {
  const context = await loadCourierDelivery(admin, token)
  if (!context) return { status: 404, body: { ok: false, message: "Este código QR no es válido." } }
  const { screen } = context.view

  if (request.action === "delivered") {
    if (screen.kind === "delivered") return reply(admin, token, 200, true, "already_delivered", COURIER_RESULT_MESSAGES.already_delivered)
    if (screen.kind !== "actions") {
      return reply(admin, token, 409, false, screen.kind, SCREEN_MESSAGES[screen.kind] ?? COURIER_RESULT_MESSAGES.unchanged)
    }
    // Misma lógica canónica que Despachos: transición atómica + garantía,
    // costo logístico, historial y email del cliente.
    const result = await advanceLocalDelivery(localDeliveryServiceDeps(admin, { type: "courier", token }), context.orderId, "entregado")
    if (result.status === 200) return reply(admin, token, 200, true, "delivered", COURIER_RESULT_MESSAGES.delivered)
    const fresh = await loadCourierDelivery(admin, token)
    if (fresh?.view.screen.kind === "delivered") {
      return { status: 200, body: { ok: true, result: "already_delivered", message: COURIER_RESULT_MESSAGES.already_delivered, view: fresh.view } }
    }
    return { status: 409, body: { ok: false, result: "conflict", message: COURIER_RESULT_MESSAGES.conflict, ...(fresh ? { view: fresh.view } : {}) } }
  }

  const { data, error } = await admin.rpc("record_local_delivery_courier_outcome", {
    p_token: token,
    p_outcome: request.action,
    p_expected_attempts: request.expectedAttempts,
    p_reason: request.reason,
    p_comment: request.comment,
  })
  if (error) {
    if (error.message?.includes("LOCAL_DELIVERY_TOKEN_INVALID")) return { status: 404, body: { ok: false, message: "Este código QR no es válido." } }
    if (error.message?.includes("LOCAL_DELIVERY_COMMENT_REQUIRED")) return { status: 400, body: { ok: false, message: "Contanos brevemente qué pasó." } }
    if (error.message?.includes("LOCAL_DELIVERY_OUTCOME_INVALID")) return { status: 400, body: { ok: false, message: "Acción inválida." } }
    throw new Error("COURIER_OUTCOME_FAILED")
  }
  const outcome = data as { orderId: number; result: string; changed: boolean }
  if (outcome.changed && (outcome.result === "first_attempt_failed" || outcome.result === "returning")) {
    await sendLocalDeliveryOutcomeEmail(admin, outcome.orderId, outcome.result)
  }
  const message = COURIER_RESULT_MESSAGES[outcome.result as keyof typeof COURIER_RESULT_MESSAGES] ?? COURIER_RESULT_MESSAGES.unchanged
  const ok = outcome.changed || outcome.result === "unchanged"
  return reply(admin, token, ok || outcome.result === "already_delivered" ? 200 : 409, ok, outcome.result, message)
}
