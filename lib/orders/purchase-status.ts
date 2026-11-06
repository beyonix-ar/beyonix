import {
  classifyPurchaseOrder,
  type PurchaseCheckResult,
  type PurchasedLine,
} from "../cart/purchase-tracking.ts"
import { hasConfirmedPaymentEvidence } from "./order-payment-status.ts"

/**
 * Estado de las compras que un navegador inició, para descontarlas de su
 * carrito (/api/checkout/purchase-status). El servidor es la fuente de verdad:
 * - el pedido tiene que ser de quien pregunta (usuario_id = sesión; pedido de
 *   invitado = token firmado vigente). Si no, `unknown`, igual que si no
 *   existiera: no se filtra nada de pedidos ajenos;
 * - `paid` sólo con evidencia real de pago (hasConfirmedPaymentEvidence), y
 *   sólo entonces se devuelven los ítems comprados;
 * - cancelado/vencido/reintegrado sin pago: `void`; el resto, `pending`.
 */
export const MAX_PURCHASE_STATUS_REQUESTS = 10

export interface PurchaseStatusRequest {
  orderId: number
  guestToken: string | null
}

export interface PurchaseStatusOrderRow {
  id: number
  usuario_id: string | null
  estado: string | null
  cancelled_at: string | null
  financial_status: string | null
  payment_status: string | null
  paid_at: string | null
  payment_confirmed_amount: number | string | null
  orden_items?: Array<{
    producto_id: number
    variante_id: number | null
    conditioned_stock_id: string | null
    cantidad: number
  }> | null
}

export interface PurchaseStatusDeps {
  /** Usuario autenticado de la request, o null. */
  userId: string | null
  /** Lee los pedidos por id (con sus ítems). Lanza si la base falla. */
  loadOrders(orderIds: number[]): Promise<PurchaseStatusOrderRow[]>
  verifyGuestToken(token: string | null, orderId: number): boolean
}

/** Valida el cuerpo: lista de { orderId, guestToken? } sin duplicados. `null` si es inválido. */
export function parsePurchaseStatusRequests(body: unknown): PurchaseStatusRequest[] | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null
  const orders = (body as { orders?: unknown }).orders
  if (!Array.isArray(orders) || orders.length === 0 || orders.length > MAX_PURCHASE_STATUS_REQUESTS) return null
  const seen = new Set<number>()
  const requests: PurchaseStatusRequest[] = []
  for (const entry of orders) {
    if (!entry || typeof entry !== "object") return null
    const { orderId, guestToken } = entry as { orderId?: unknown; guestToken?: unknown }
    if (typeof orderId !== "number" || !Number.isSafeInteger(orderId) || orderId <= 0) return null
    if (guestToken !== undefined && guestToken !== null && (typeof guestToken !== "string" || guestToken.length > 4_096)) return null
    if (seen.has(orderId)) continue
    seen.add(orderId)
    requests.push({ orderId, guestToken: typeof guestToken === "string" && guestToken ? guestToken : null })
  }
  return requests
}

function canAccess(order: PurchaseStatusOrderRow, request: PurchaseStatusRequest, deps: PurchaseStatusDeps) {
  // Un pedido con dueño sólo lo ve su dueño: un token de invitado no alcanza.
  if (order.usuario_id) return deps.userId !== null && order.usuario_id === deps.userId
  return deps.verifyGuestToken(request.guestToken, order.id)
}

function purchasedLines(order: PurchaseStatusOrderRow): PurchasedLine[] {
  return (order.orden_items ?? [])
    .filter((item) => Number.isSafeInteger(item.producto_id) && Number(item.cantidad) > 0)
    .map((item) => ({
      productId: item.producto_id,
      variantId: item.variante_id ?? null,
      conditionedStockId: item.conditioned_stock_id ?? null,
      quantity: Math.trunc(Number(item.cantidad)),
    }))
}

export async function resolvePurchaseStatuses(
  requests: readonly PurchaseStatusRequest[],
  deps: PurchaseStatusDeps,
): Promise<PurchaseCheckResult[]> {
  const orders = await deps.loadOrders(requests.map((request) => request.orderId))
  const byId = new Map(orders.map((order) => [order.id, order]))
  return requests.map((request) => {
    const order = byId.get(request.orderId)
    if (!order || !canAccess(order, request, deps)) return { orderId: request.orderId, status: "unknown" }
    const status = classifyPurchaseOrder({
      estado: order.estado,
      cancelled_at: order.cancelled_at,
      financial_status: order.financial_status,
      paid: hasConfirmedPaymentEvidence({
        financial_status: order.financial_status,
        paid_at: order.paid_at,
        payment_confirmed_amount: Number(order.payment_confirmed_amount ?? 0),
        payment_status: order.payment_status,
      }),
    })
    return status === "paid"
      ? { orderId: order.id, status, items: purchasedLines(order) }
      : { orderId: order.id, status }
  })
}
