import assert from "node:assert/strict"
import test from "node:test"

import type { CartItem } from "./cart-items.ts"
import {
  APPLIED_PURCHASE_RETENTION_MS,
  classifyPurchaseOrder,
  MAX_TRACKED_PURCHASES,
  parsePurchaseCheckResults,
  parseTrackedPurchases,
  pruneTrackedPurchases,
  registerTrackedPurchase,
  removePurchasedLines,
  shouldApplyPurchaseInTab,
  TRACKED_PURCHASE_TTL_MS,
  type TrackedPurchase,
} from "./purchase-tracking.ts"

const line = (productId: number, quantity: number, variantId: number | null = null, conditionedStockId: string | null = null) => ({
  product: { id: productId, nombre: `Producto ${productId}`, precio: 1000 },
  color: variantId ? `variant:${variantId}` : "default",
  image: "",
  quantity,
  variantId,
  conditionedStockId,
  variantName: null,
  colorHex: null,
  unitPrice: 1000,
  originalUnitPrice: null,
  discountReason: null,
}) as unknown as CartItem

const summary = (cart: CartItem[]) => cart.map((item) => [item.product.id, item.variantId, item.quantity])

test("descuenta exactamente lo comprado: otros productos y unidades agregadas después quedan", () => {
  // Compra A×1; mientras el pago estaba pendiente agregó B y otra unidad de A.
  const cart = [line(1, 2), line(2, 1), line(3, 1, 31)]
  const next = removePurchasedLines(cart, [{ productId: 1, variantId: null, conditionedStockId: null, quantity: 1 }])
  assert.deepEqual(summary(next), [[1, null, 1], [2, null, 1], [3, 31, 1]])
  // Toda la línea comprada desaparece; la variante distinta del mismo producto no se toca.
  const sameProductOtherVariant = removePurchasedLines([line(3, 1, 31), line(3, 2, 32)], [{ productId: 3, variantId: 32, conditionedStockId: null, quantity: 2 }])
  assert.deepEqual(summary(sameProductOtherVariant), [[3, 31, 1]])
  // Acondicionado: sólo la línea con el mismo stock acondicionado.
  const conditioned = removePurchasedLines([line(4, 1, null, "c-1"), line(4, 1)], [{ productId: 4, variantId: null, conditionedStockId: "c-1", quantity: 1 }])
  assert.deepEqual(summary(conditioned), [[4, null, 1]])
  assert.equal(conditioned[0].conditionedStockId, null)
})

test("sin coincidencias o con líneas inválidas devuelve la misma referencia (sin re-render)", () => {
  const cart = [line(1, 1)]
  assert.equal(removePurchasedLines(cart, []), cart)
  assert.equal(removePurchasedLines(cart, [{ productId: 9, variantId: null, conditionedStockId: null, quantity: 1 }]), cart)
  assert.equal(removePurchasedLines(cart, [{ productId: 1, variantId: null, conditionedStockId: null, quantity: 0 }]), cart)
  // Comprado más de lo que hay (ya lo había quitado a mano): nunca negativo.
  assert.deepEqual(removePurchasedLines([line(1, 1)], [{ productId: 1, variantId: null, conditionedStockId: null, quantity: 5 }]), [])
})

test("pago confirmado = evidencia real; pendiente, rechazado, cancelado y reintegrado no vacían", () => {
  assert.equal(classifyPurchaseOrder({ paid: true, estado: "pagado" }), "paid")
  assert.equal(classifyPurchaseOrder({ paid: false, estado: "pendiente", financial_status: "pending_payment" }), "pending")
  // Mercado Pago rechazado deja el pedido esperando otro intento: sigue pendiente, carrito intacto.
  assert.equal(classifyPurchaseOrder({ paid: false, estado: "pendiente", financial_status: "pending_payment" }), "pending")
  assert.equal(classifyPurchaseOrder({ paid: false, estado: "cancelado", financial_status: "cancelled" }), "void")
  assert.equal(classifyPurchaseOrder({ paid: false, estado: "pendiente", cancelled_at: "2026-11-05T10:00:00Z" }), "void")
  assert.equal(classifyPurchaseOrder({ paid: false, estado: "cancelado", financial_status: "refunded" }), "void")
})

test("registro: deduplica por pedido, conserva los más recientes y descarta lo inválido", () => {
  let list: TrackedPurchase[] = []
  list = registerTrackedPurchase(list, { orderId: 10, guestToken: "tok", sessionId: "s1" }, 1000)
  list = registerTrackedPurchase(list, { orderId: 10, guestToken: "tok2", sessionId: "s1" }, 2000)
  assert.deepEqual(list, [{ orderId: 10, guestToken: "tok2", sessionId: "s1", createdAt: 2000, appliedAt: null }])
  assert.deepEqual(registerTrackedPurchase(list, { orderId: -1 }, 3000), list)
  for (let id = 1; id <= MAX_TRACKED_PURCHASES + 3; id += 1) list = registerTrackedPurchase(list, { orderId: 100 + id }, 3000 + id)
  assert.equal(list.length, MAX_TRACKED_PURCHASES)
  assert.equal(list.at(-1)?.orderId, 100 + MAX_TRACKED_PURCHASES + 3)

  const raw = JSON.stringify([
    { orderId: 5, createdAt: 10, guestToken: "t", sessionId: "s", appliedAt: null },
    { orderId: 5, createdAt: 11 },
    { orderId: "6", createdAt: 10 },
    { orderId: 7 },
    null,
    { orderId: 8, createdAt: 12, appliedAt: 20, guestToken: 3 },
  ])
  assert.deepEqual(parseTrackedPurchases(raw), [
    { orderId: 5, guestToken: "t", sessionId: "s", createdAt: 10, appliedAt: null },
    { orderId: 8, guestToken: null, sessionId: null, createdAt: 12, appliedAt: 20 },
  ])
  assert.deepEqual(parseTrackedPurchases("{no json"), [])
  assert.deepEqual(parseTrackedPurchases('{"orderId":1}'), [])
})

test("vencimiento: sin confirmar 7 días se descarta; lo aplicado se guarda 2 días para otras pestañas", () => {
  const now = 100 * 24 * 60 * 60 * 1000
  const list: TrackedPurchase[] = [
    { orderId: 1, guestToken: null, sessionId: null, createdAt: now - TRACKED_PURCHASE_TTL_MS - 1, appliedAt: null },
    { orderId: 2, guestToken: null, sessionId: null, createdAt: now - 1000, appliedAt: null },
    { orderId: 3, guestToken: null, sessionId: null, createdAt: now - 1000, appliedAt: now - APPLIED_PURCHASE_RETENTION_MS - 1 },
    { orderId: 4, guestToken: null, sessionId: null, createdAt: now - 1000, appliedAt: now - 1000 },
  ]
  assert.deepEqual(pruneTrackedPurchases(list, now).map((item) => item.orderId), [2, 4])
})

test("pestañas: aplica una vez por carrito cargado; una pestaña cargada después no repite", () => {
  const applied = new Set<number>()
  // Nunca aplicada: aplica.
  assert.equal(shouldApplyPurchaseInTab({ orderId: 1, appliedAt: null }, 1000, applied), true)
  // Otra pestaña la aplicó DESPUÉS de que esta cargara su carrito: esta también descuenta.
  assert.equal(shouldApplyPurchaseInTab({ orderId: 1, appliedAt: 2000 }, 1000, applied), true)
  // Esta pestaña cargó el carrito ya descontado (recarga o pestaña nueva): no repite.
  assert.equal(shouldApplyPurchaseInTab({ orderId: 1, appliedAt: 2000 }, 3000, applied), false)
  // Ya aplicada en esta pestaña: nunca dos veces (webhook repetido, varias revisiones).
  applied.add(1)
  assert.equal(shouldApplyPurchaseInTab({ orderId: 1, appliedAt: null }, 1000, applied), false)
})

test("respuesta del servidor: sólo `paid` trae ítems; formas inesperadas se ignoran", () => {
  assert.deepEqual(parsePurchaseCheckResults({ orders: [
    { orderId: 1, status: "paid", items: [{ productId: 7, quantity: 2, variantId: 70, conditionedStockId: null }, { productId: "x", quantity: 1 }] },
    { orderId: 2, status: "pending", items: [{ productId: 9, quantity: 1 }] },
    { orderId: 3, status: "void" },
    { orderId: 4, status: "unknown" },
    { orderId: 5, status: "approved" },
    { orderId: 6, status: "paid" },
  ] }), [
    { orderId: 1, status: "paid", items: [{ productId: 7, quantity: 2, variantId: 70, conditionedStockId: null }] },
    { orderId: 2, status: "pending" },
    { orderId: 3, status: "void" },
    { orderId: 4, status: "unknown" },
  ])
  assert.deepEqual(parsePurchaseCheckResults(null), [])
  assert.deepEqual(parsePurchaseCheckResults({ orders: "x" }), [])
})
