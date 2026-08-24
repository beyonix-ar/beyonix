import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  CheckoutShippingQuoteError,
  createCheckoutShippingQuoteToken,
  normalizeCheckoutShipping,
  type CheckoutShippingQuoteBinding,
} from "./checkout-shipping.ts"

const TEST_SECRET = "beyonix-checkout-shipping-test-secret-2026"
const NOW = Date.UTC(2026, 7, 15, 12)
const binding: CheckoutShippingQuoteBinding = {
  cpDestino: "3230",
  localidad: "Paso de los Libres",
  provincia: "Corrientes",
  items: [
    { productId: 10, quantity: 2, variantId: 4 },
    {
      productId: 12,
      quantity: 1,
      conditionedStockId: "123e4567-e89b-12d3-a456-426614174000",
    },
  ],
}

function createQuoteToken(price = 18_000) {
  return createCheckoutShippingQuoteToken(
    binding,
    { type: "domicilio", price },
    { secret: TEST_SECRET, now: NOW },
  )
}

test("el costo real proviene de la cotización firmada y no del navegador", () => {
  const shipping = normalizeCheckoutShipping(
    {
      provider: "andreani",
      type: "domicilio",
      quoteToken: createQuoteToken(),
      costReal: 1,
    },
    binding,
    100_000,
    {
      secret: TEST_SECRET,
      now: NOW,
      settings: {
        defaultShippingCost: 12_000,
        freeShippingMinAmount: 80_000,
        shippingBonusMax: 5_000,
        freeShippingMode: "full",
        logisticsBaseSubsidy: 0,
      },
    },
  )

  assert.equal(shipping.costReal, 18_000)
  assert.equal(shipping.costCharged, 13_000)
})

test("todos los medios de pago consumen la misma cotización verificada", () => {
  const quoteToken = createQuoteToken(12_345.67)
  const paymentMethods = [
    "mercadopago",
    "transferencia",
    "customer_credit",
  ] as const

  const results = paymentMethods.map((paymentMethod) => ({
    paymentMethod,
    shipping: normalizeCheckoutShipping(
      { provider: "andreani", type: "domicilio", quoteToken },
      binding,
      20_000,
      {
        secret: TEST_SECRET,
        now: NOW,
        customerCreditApplied: paymentMethod === "customer_credit",
        settings: {
          defaultShippingCost: 0,
          freeShippingMinAmount: 999_999,
          shippingBonusMax: 0,
          freeShippingMode: "off",
          logisticsBaseSubsidy: 0,
        },
      },
    ),
  }))

  assert.deepEqual(
    results.map(({ shipping }) => shipping.costReal),
    [12_345.67, 12_345.67, 12_345.67],
  )
  assert.deepEqual(
    results.map(({ shipping }) => shipping.costCharged),
    [12_345.67, 12_345.67, 0],
  )
})

test("las tres rutas de órdenes validan el token mediante el helper común", () => {
  const routes = [
    "../../app/api/mercadopago/create-preference/route.ts",
    "../../app/api/transferencia/create-order/route.ts",
    "../../app/api/customer-credit/create-order/route.ts",
  ]

  for (const route of routes) {
    const source = readFileSync(new URL(route, import.meta.url), "utf8")
    assert.match(source, /normalizeCheckoutOrderShipping\(/)
    assert.doesNotMatch(source, /costReal\?: number/)
    assert.doesNotMatch(source, /quoted\?: boolean/)
  }
})

test("rechaza una firma alterada aunque el cliente envíe un costo positivo", () => {
  const quoteToken = createQuoteToken()
  const alteredToken = `${quoteToken.slice(0, -1)}${quoteToken.endsWith("a") ? "b" : "a"}`

  assert.throws(
    () =>
      normalizeCheckoutShipping(
        {
          type: "domicilio",
          quoteToken: alteredToken,
          costReal: 99_999,
        },
        binding,
        100_000,
        { secret: TEST_SECRET, now: NOW },
      ),
    CheckoutShippingQuoteError,
  )
})

test("rechaza reutilizar una cotización con otro carrito o destino", () => {
  const shipping = { type: "domicilio" as const, quoteToken: createQuoteToken() }

  assert.throws(
    () =>
      normalizeCheckoutShipping(
        shipping,
        { ...binding, cpDestino: "3400" },
        100_000,
        { secret: TEST_SECRET, now: NOW },
      ),
    CheckoutShippingQuoteError,
  )
  assert.throws(
    () =>
      normalizeCheckoutShipping(
        shipping,
        {
          ...binding,
          items: [{ productId: 10, quantity: 1, variantId: 4 }],
        },
        100_000,
        { secret: TEST_SECRET, now: NOW },
      ),
    CheckoutShippingQuoteError,
  )
})

test("rechaza cotizaciones vencidas", () => {
  assert.throws(
    () =>
      normalizeCheckoutShipping(
        { type: "domicilio", quoteToken: createQuoteToken() },
        binding,
        100_000,
        { secret: TEST_SECRET, now: NOW + 31 * 60 * 1000 },
      ),
    CheckoutShippingQuoteError,
  )
})
