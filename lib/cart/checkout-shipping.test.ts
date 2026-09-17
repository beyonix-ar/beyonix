import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  CheckoutShippingQuoteError,
  createCheckoutShippingQuoteToken,
  normalizeCheckoutShipping,
  type CheckoutShippingQuoteBinding,
} from "./checkout-shipping.ts"
import { calculateCustomerShippingCost, DEFAULT_SHIPPING_SETTINGS } from "../store-config.ts"

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

function createQuoteToken(price = 18_000, costCharged = price) {
  return createCheckoutShippingQuoteToken(
    binding,
    { type: "domicilio", price, costCharged },
    { secret: TEST_SECRET, now: NOW },
  )
}

test("el costo real proviene de la cotización firmada y no del navegador", () => {
  const settings = {
    defaultShippingCost: 12_000,
    freeShippingMinAmount: 80_000,
    shippingBonusMax: 5_000,
    freeShippingMode: "full" as const,
    logisticsBaseSubsidy: 0,
  }
  const shipping = normalizeCheckoutShipping(
    {
      provider: "andreani",
      type: "domicilio",
      quoteToken: createQuoteToken(
        18_000,
        calculateCustomerShippingCost(100_000, 18_000, settings),
      ),
      costReal: 1,
    },
    binding,
    100_000,
    {
      secret: TEST_SECRET,
      now: NOW,
      settings,
    },
  )

  assert.equal(shipping.costReal, 18_000)
  assert.equal(shipping.costCharged, 13_000)
})

test("todos los medios de pago consumen la misma cotización verificada", () => {
  const settings = {
    defaultShippingCost: 0,
    freeShippingMinAmount: 999_999,
    shippingBonusMax: 0,
    freeShippingMode: "off" as const,
    logisticsBaseSubsidy: 0,
  }
  const quoteToken = createQuoteToken(
    12_345.67,
    calculateCustomerShippingCost(20_000, 12_345.67, settings),
  )
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
        settings,
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

test("BLOQUEANTE 1: el importe mostrado al cotizar es EXACTAMENTE el que se persiste cuando nada cambió", () => {
  const settings = {
    defaultShippingCost: 12_000,
    freeShippingMinAmount: 80_000,
    shippingBonusMax: 5_000,
    freeShippingMode: "full" as const,
    logisticsBaseSubsidy: 0,
  }
  const productsTotal = 100_000
  const costCharged = calculateCustomerShippingCost(productsTotal, 18_000, settings)
  const quoteToken = createQuoteToken(18_000, costCharged)

  const shipping = normalizeCheckoutShipping(
    { provider: "andreani", type: "domicilio", quoteToken },
    binding,
    productsTotal,
    { secret: TEST_SECRET, now: NOW, settings },
  )

  // El importe "mostrado" (firmado al cotizar) y el "persistido" (recalculado
  // al crear la orden) son el mismo número exacto -- no una coincidencia,
  // sino la garantía que exige el fix.
  assert.equal(shipping.costCharged, costCharged)
})

test("BLOQUEANTE 1: si la configuración comercial cambia entre cotizar y crear la orden, se exige recotizar (nunca se persiste un importe distinto en silencio)", () => {
  const settingsAtQuoteTime = {
    defaultShippingCost: 12_000,
    freeShippingMinAmount: 80_000,
    shippingBonusMax: 5_000,
    freeShippingMode: "full" as const,
    logisticsBaseSubsidy: 0,
  }
  const productsTotal = 100_000
  const costChargedAtQuoteTime = calculateCustomerShippingCost(
    productsTotal,
    18_000,
    settingsAtQuoteTime,
  )
  const quoteToken = createQuoteToken(18_000, costChargedAtQuoteTime)

  // Un admin sube el umbral de envío gratis DESPUÉS de que el cliente cotizó
  // -- con la config nueva, el mismo carrito ya no califica para bonificación
  // y el importe recalculado sería mayor al que el cliente vio.
  const settingsAtOrderCreationTime = {
    ...settingsAtQuoteTime,
    freeShippingMinAmount: 500_000,
  }

  assert.throws(
    () =>
      normalizeCheckoutShipping(
        { provider: "andreani", type: "domicilio", quoteToken },
        binding,
        productsTotal,
        { secret: TEST_SECRET, now: NOW, settings: settingsAtOrderCreationTime },
      ),
    CheckoutShippingQuoteError,
  )
})

test("BLOQUEANTE 1: si el precio de catálogo cambia el subtotal entre cotizar y crear la orden, se exige recotizar", () => {
  const settings = {
    defaultShippingCost: 12_000,
    freeShippingMinAmount: 80_000,
    shippingBonusMax: 5_000,
    freeShippingMode: "full" as const,
    logisticsBaseSubsidy: 0,
  }
  const productsTotalAtQuoteTime = 100_000
  const costChargedAtQuoteTime = calculateCustomerShippingCost(
    productsTotalAtQuoteTime,
    18_000,
    settings,
  )
  const quoteToken = createQuoteToken(18_000, costChargedAtQuoteTime)

  // El precio de un producto del carrito bajó entre que el cliente cotizó y
  // confirmó la compra: el subtotal recalculado ya no alcanza el mínimo de
  // envío gratis que sí cumplía al cotizar.
  const productsTotalAtOrderCreationTime = 50_000

  assert.throws(
    () =>
      normalizeCheckoutShipping(
        { provider: "andreani", type: "domicilio", quoteToken },
        binding,
        productsTotalAtOrderCreationTime,
        { secret: TEST_SECRET, now: NOW, settings },
      ),
    CheckoutShippingQuoteError,
  )
})

test("firma vinculada a dirección, sucursal idgla, variante, cantidad y vencimiento exacto", () => {
  const bound = { ...binding, direccion: "San Martín 123", sucursalId: 10055 }
  const costCharged = calculateCustomerShippingCost(10000, 12000, DEFAULT_SHIPPING_SETTINGS)
  const quoteToken = createCheckoutShippingQuoteToken(bound, { type: "sucursal", price: 12000, costCharged }, { secret: TEST_SECRET, now: NOW })
  const shipping = { type: "sucursal" as const, quoteToken }
  assert.equal(normalizeCheckoutShipping(shipping, bound, 10000, { secret: TEST_SECRET, now: NOW }).costReal, 12000)
  for (const changed of [
    { ...bound, direccion: "San Martín 124" }, { ...bound, sucursalId: 10056 },
    { ...bound, sucursalId: null }, { ...bound, provincia: "Santa Fe" },
    { ...bound, items: [{ productId: 10, variantId: 5, quantity: 2 }] },
    { ...bound, items: [{ productId: 10, variantId: 4, quantity: 3 }] },
  ]) {
    assert.throws(() => normalizeCheckoutShipping(shipping, changed, 10000, { secret: TEST_SECRET, now: NOW }), CheckoutShippingQuoteError)
  }
  assert.throws(() => normalizeCheckoutShipping(shipping, bound, 10000, { secret: TEST_SECRET, now: NOW + 30 * 60 * 1000 }), CheckoutShippingQuoteError)
})
