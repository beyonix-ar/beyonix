/**
 * Compras de prueba internas (sólo super_admin). Fuente de verdad: la RPC
 * classify_test_order_admin (20261124120000_test_order_classification.sql),
 * que revalida permisos, confirmación, bloqueos y reingreso de stock. Este
 * módulo sólo comparte contratos y textos entre la ruta y el panel.
 */

import { formatPublicOrderId } from "../account/account-formatters.ts"
import { ORDER_ARCHIVE_BLOCKER_LABELS } from "./order-visibility.ts"

export const TEST_ORDER_REASON_MIN = 10
export const TEST_ORDER_REASON_MAX = 500

export const TEST_ORDER_BLOCKER_LABELS: Record<string, string> = {
  ...ORDER_ARCHIVE_BLOCKER_LABELS,
  already_classified: "El pedido ya está clasificado como prueba.",
  not_authorized_test_order: "Este pedido no está autorizado como compra de prueba. Sólo se clasifican pruebas verificadas y autorizadas de antemano.",
  test_authorization_mismatch: "El pedido ya no coincide con la compra de prueba autorizada (comprador, total, pago o artículos).",
  payment_not_confirmed: "El pago del pedido ya no figura aprobado y confirmado (por ejemplo, se revirtió o está en reintegro).",
  payment_amount_mismatch: "El importe confirmado del pago no coincide con el de la compra de prueba autorizada.",
  buyer_not_internal: "Sólo se pueden clasificar compras hechas con una cuenta interna del equipo, nunca la de un cliente.",
  local_delivery_return_pending: "Hay un retorno de entrega local pendiente.",
}

export function describeTestOrderBlockers(codes: readonly string[]) {
  return codes.map((code) => TEST_ORDER_BLOCKER_LABELS[code] ?? code)
}

/** Texto que el super_admin tiene que escribir para confirmar (BX-1019). */
export function testOrderConfirmationText(orderId: number) {
  return formatPublicOrderId(orderId)
}

export function isTestOrderConfirmationValid(orderId: number, value: string) {
  return value.trim().toUpperCase() === testOrderConfirmationText(orderId)
}

export function normalizeTestOrderReason(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

export function isTestOrderReasonValid(reason: string) {
  return reason.length >= TEST_ORDER_REASON_MIN && reason.length <= TEST_ORDER_REASON_MAX
}

export interface TestOrderRestockPlanItem {
  orderItemId: number
  productId: number
  variantId: number | null
  productName: string
  variantName: string | null
  quantity: number
  consumed: number
  returned: number
  released: number
  compensated: number
  pending: number
  supported: boolean
}

function toInteger(value: unknown) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

/** Valida la respuesta de order_test_restock_plan (nunca se confía a ciegas). */
export function parseTestOrderRestockPlan(value: unknown): TestOrderRestockPlanItem[] | null {
  if (!Array.isArray(value)) return null
  const items: TestOrderRestockPlanItem[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== "object") return null
    const row = raw as Record<string, unknown>
    const orderItemId = toInteger(row.orderItemId)
    const productId = toInteger(row.productId)
    const quantity = toInteger(row.quantity)
    const consumed = toInteger(row.consumed)
    const returned = toInteger(row.returned)
    const released = toInteger(row.released)
    const compensated = toInteger(row.compensated)
    const pending = toInteger(row.pending)
    if (
      orderItemId === null || productId === null || quantity === null || consumed === null ||
      returned === null || released === null || compensated === null || pending === null || pending < 0
    ) return null
    items.push({
      orderItemId,
      productId,
      variantId: row.variantId == null ? null : toInteger(row.variantId),
      productName: typeof row.productName === "string" ? row.productName : `Producto #${productId}`,
      variantName: typeof row.variantName === "string" ? row.variantName : null,
      quantity,
      consumed,
      returned,
      released,
      compensated,
      pending,
      supported: row.supported === true,
    })
  }
  return items
}

export function pendingRestockUnits(plan: readonly TestOrderRestockPlanItem[]) {
  return plan.reduce((total, item) => total + item.pending, 0)
}

export function hasUnsupportedRestock(plan: readonly TestOrderRestockPlanItem[]) {
  return plan.some((item) => item.pending > 0 && !item.supported)
}

/** Pedido excluido de las estadísticas comerciales (pago y factura se conservan). */
export function isTestOrder(order: { test_order_at?: string | null }) {
  return Boolean(order.test_order_at)
}
