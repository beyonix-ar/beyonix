import assert from "node:assert/strict"
import test from "node:test"

import { normalizeCheckoutShipping } from "./checkout-shipping.ts"

test("usa la tarifa real de Andreani para calcular la bonificación", () => {
  const shipping = normalizeCheckoutShipping(
    { type: "domicilio", costReal: 18_000, quoted: true },
    100_000,
    {
      settings: {
        defaultShippingCost: 12_000,
        freeShippingMinAmount: 80_000,
        shippingBonusMax: 5_000,
        freeShippingMode: "full",
      },
    },
  )

  assert.equal(shipping.costReal, 18_000)
  assert.equal(shipping.costCharged, 13_000)
})

test("una cotización pendiente no usa un costo fijo oculto", () => {
  const shipping = normalizeCheckoutShipping(
    { type: "domicilio", costReal: 12_000, quoted: false },
    100_000,
  )

  assert.equal(shipping.costReal, 0)
  assert.equal(shipping.costCharged, 0)
  assert.equal(shipping.freeShippingApplied, false)
})

test("rechaza una supuesta cotización sin importe válido", () => {
  assert.throws(
    () => normalizeCheckoutShipping({ costReal: 0, quoted: true }, 100_000),
    /importe válido/,
  )
})
