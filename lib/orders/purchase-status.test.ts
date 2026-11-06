import assert from "node:assert/strict"
import test from "node:test"

import {
  MAX_PURCHASE_STATUS_REQUESTS,
  parsePurchaseStatusRequests,
  resolvePurchaseStatuses,
  type PurchaseStatusDeps,
  type PurchaseStatusOrderRow,
} from "./purchase-status.ts"

const PAID = {
  estado: "pagado", cancelled_at: null, financial_status: "payment_confirmed", payment_status: "approved",
  paid_at: "2026-11-05T12:00:00Z", payment_confirmed_amount: 25_000,
}
const PENDING = {
  estado: "pendiente", cancelled_at: null, financial_status: "pending_payment", payment_status: "preference_created",
  paid_at: null, payment_confirmed_amount: null,
}
const ITEMS = [{ producto_id: 7, variante_id: 70, conditioned_stock_id: null, cantidad: 2 }]

function deps(orders: PurchaseStatusOrderRow[], userId: string | null, validTokens: Record<number, string> = {}): PurchaseStatusDeps & { reads: number[][] } {
  const reads: number[][] = []
  return {
    userId,
    reads,
    async loadOrders(ids) { reads.push(ids); return orders.filter((order) => ids.includes(order.id)) },
    verifyGuestToken: (token, orderId) => token !== null && validTokens[orderId] === token,
  }
}

test("pago confirmado del propio usuario: devuelve los ítems comprados", async () => {
  const store = deps([{ id: 1, usuario_id: "u1", ...PAID, orden_items: ITEMS }], "u1")
  assert.deepEqual(await resolvePurchaseStatuses([{ orderId: 1, guestToken: null }], store), [
    { orderId: 1, status: "paid", items: [{ productId: 7, variantId: 70, conditionedStockId: null, quantity: 2 }] },
  ])
})

test("pendiente, rechazado o cancelado: nunca devuelve ítems (el carrito no se toca)", async () => {
  const store = deps([
    { id: 2, usuario_id: "u1", ...PENDING, orden_items: ITEMS },
    // MP rechazó el pago: el pedido sigue esperando otro intento.
    { id: 3, usuario_id: "u1", ...PENDING, payment_status: "rejected", orden_items: ITEMS },
    { id: 4, usuario_id: "u1", ...PENDING, estado: "cancelado", financial_status: "cancelled", cancelled_at: "2026-11-05T13:00:00Z", orden_items: ITEMS },
    // Transferencia con comprobante subido pero sin confirmar: sigue pendiente.
    { id: 5, usuario_id: "u1", ...PENDING, payment_status: "pendiente_verificacion", orden_items: ITEMS },
    // Pagado y después reintegrado: ya no hay pago confirmado.
    { id: 6, usuario_id: "u1", ...PAID, estado: "cancelado", financial_status: "refunded", orden_items: ITEMS },
  ], "u1")
  const results = await resolvePurchaseStatuses([2, 3, 4, 5, 6].map((orderId) => ({ orderId, guestToken: null })), store)
  assert.deepEqual(results, [
    { orderId: 2, status: "pending" },
    { orderId: 3, status: "pending" },
    { orderId: 4, status: "void" },
    { orderId: 5, status: "pending" },
    { orderId: 6, status: "void" },
  ])
})

test("evidencia parcial no alcanza: paid_at sin monto/estado confirmado no es pago", async () => {
  const store = deps([{ id: 8, usuario_id: "u1", ...PENDING, paid_at: "2026-11-05T12:00:00Z", orden_items: ITEMS }], "u1")
  assert.deepEqual(await resolvePurchaseStatuses([{ orderId: 8, guestToken: null }], store), [{ orderId: 8, status: "pending" }])
})

test("pedido ajeno: `unknown`, igual que inexistente, sin ítems ni estado", async () => {
  const orders: PurchaseStatusOrderRow[] = [
    { id: 10, usuario_id: "otro", ...PAID, orden_items: ITEMS },
    { id: 11, usuario_id: null, ...PAID, orden_items: ITEMS },
  ]
  // Usuario que pregunta por el pedido de otro (aunque mande un token válido de otro pedido).
  assert.deepEqual(await resolvePurchaseStatuses([{ orderId: 10, guestToken: "tok-11" }], deps(orders, "u1", { 11: "tok-11" })), [{ orderId: 10, status: "unknown" }])
  // Sin sesión, pedido con dueño: nunca alcanza un token.
  assert.deepEqual(await resolvePurchaseStatuses([{ orderId: 10, guestToken: "tok-10" }], deps(orders, null, { 10: "tok-10" })), [{ orderId: 10, status: "unknown" }])
  // Invitado sin token, con token de otro pedido o inválido.
  for (const guestToken of [null, "tok-10", "falso"]) {
    assert.deepEqual(await resolvePurchaseStatuses([{ orderId: 11, guestToken }], deps(orders, null, { 11: "tok-11" })), [{ orderId: 11, status: "unknown" }], String(guestToken))
  }
  // Inexistente.
  assert.deepEqual(await resolvePurchaseStatuses([{ orderId: 99, guestToken: null }], deps(orders, "u1")), [{ orderId: 99, status: "unknown" }])
})

test("invitado con su token: ve el estado de su pedido", async () => {
  const store = deps([{ id: 11, usuario_id: null, ...PAID, orden_items: ITEMS }], null, { 11: "tok-11" })
  const [result] = await resolvePurchaseStatuses([{ orderId: 11, guestToken: "tok-11" }], store)
  assert.equal(result.status, "paid")
  // El mismo token sirve aunque después haya iniciado sesión (el pedido sigue siendo de invitado).
  const logged = deps([{ id: 11, usuario_id: null, ...PAID, orden_items: ITEMS }], "u1", { 11: "tok-11" })
  assert.equal((await resolvePurchaseStatuses([{ orderId: 11, guestToken: "tok-11" }], logged))[0].status, "paid")
})

test("confirmación repetida (webhook duplicado): misma respuesta, una sola lectura por consulta", async () => {
  const store = deps([{ id: 1, usuario_id: "u1", ...PAID, orden_items: ITEMS }], "u1")
  const first = await resolvePurchaseStatuses([{ orderId: 1, guestToken: null }], store)
  const second = await resolvePurchaseStatuses([{ orderId: 1, guestToken: null }], store)
  assert.deepEqual(first, second)
  assert.deepEqual(store.reads, [[1], [1]])
})

test("validación del cuerpo: lista acotada, ids enteros positivos, sin duplicados", () => {
  assert.deepEqual(parsePurchaseStatusRequests({ orders: [{ orderId: 1, guestToken: "t" }, { orderId: 1 }, { orderId: 2 }] }), [
    { orderId: 1, guestToken: "t" },
    { orderId: 2, guestToken: null },
  ])
  for (const body of [null, [], {}, { orders: [] }, { orders: [{ orderId: "1" }] }, { orders: [{ orderId: 0 }] }, { orders: [{ orderId: 1.5 }] },
    { orders: [{ orderId: 1, guestToken: 5 }] }, { orders: Array.from({ length: MAX_PURCHASE_STATUS_REQUESTS + 1 }, (_, index) => ({ orderId: index + 1 })) }]) {
    assert.equal(parsePurchaseStatusRequests(body), null, JSON.stringify(body)?.slice(0, 60))
  }
})
