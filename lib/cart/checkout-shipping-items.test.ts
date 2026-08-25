import assert from "node:assert/strict"
import test from "node:test"

import { canonicalizeCheckoutQuoteItems } from "./checkout-shipping-items.ts"

test("agrupa y suma cantidades de la misma línea (producto+variante+stock condicionado)", () => {
  const result = canonicalizeCheckoutQuoteItems([
    { productId: 1, quantity: 2, variantId: 5, conditionedStockId: null },
    { productId: 1, quantity: 3, variantId: 5, conditionedStockId: null },
  ])

  assert.deepEqual(result, [
    { productId: 1, quantity: 5, variantId: 5, conditionedStockId: null },
  ])
})

test("el orden de entrada no afecta el resultado (mismos ítems, distinto orden)", () => {
  const items = [
    { productId: 3, quantity: 1, variantId: null, conditionedStockId: null },
    { productId: 1, quantity: 2, variantId: 9, conditionedStockId: null },
  ]

  const a = canonicalizeCheckoutQuoteItems(items)
  const b = canonicalizeCheckoutQuoteItems([...items].reverse())

  assert.deepEqual(a, b)
})

test("conditionedStockId presente anula variantId (igual que canonicalizeQuoteBinding)", () => {
  const result = canonicalizeCheckoutQuoteItems([
    {
      productId: 1,
      quantity: 1,
      variantId: 5,
      conditionedStockId: "11111111-1111-4111-8111-111111111111",
    },
  ])

  assert.equal(result[0].variantId, null)
  assert.equal(result[0].conditionedStockId, "11111111-1111-4111-8111-111111111111")
})

test("líneas con distinto conditionedStockId no se agrupan entre sí", () => {
  const result = canonicalizeCheckoutQuoteItems([
    {
      productId: 1,
      quantity: 1,
      variantId: null,
      conditionedStockId: "11111111-1111-4111-8111-111111111111",
    },
    {
      productId: 1,
      quantity: 1,
      variantId: null,
      conditionedStockId: "22222222-2222-4222-8222-222222222222",
    },
  ])

  assert.equal(result.length, 2)
})
