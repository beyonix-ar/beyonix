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
import { buildShippingPriceBreakdown, markupPercentToBasisPoints } from "../shipping/shipping-pricing.ts"

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

const ESTIMATE = {
  version: "beyonix-packing-v1",
  parcels: [{ lengthCm: 32, widthCm: 22, heightCm: 19, volumeCm3: 13_376, weightKg: 1.94 }],
  productsWeightKg: 1.8,
  productsVolumeCm3: 8_784,
}

/** Opción con desglose consistente: tarifa Andreani + recargo + redondeo a $10. */
function pricedOption(
  type: "domicilio" | "sucursal",
  providerAmount: number,
  costCharged?: number,
  markupPercent = 0,
) {
  const breakdown = buildShippingPriceBreakdown(providerAmount, markupPercentToBasisPoints(markupPercent))
  const price = breakdown.logisticsCents / 100
  return {
    type,
    price,
    costCharged: costCharged ?? price,
    pricing: {
      providerAmount,
      markupPercent,
      markupAmount: breakdown.markupCents / 100,
      roundingAmount: breakdown.roundingCents / 100,
    },
    estimate: ESTIMATE,
  }
}

function createQuoteToken(price = 18_000, costCharged = price) {
  return createCheckoutShippingQuoteToken(
    binding,
    pricedOption("domicilio", price, costCharged),
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
      markupPercent: 0,
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
    12_000,
    calculateCustomerShippingCost(20_000, 12_000, settings),
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
        markupPercent: 0,
      },
    ),
  }))

  assert.deepEqual(
    results.map(({ shipping }) => shipping.costReal),
    [12_000, 12_000, 12_000],
  )
  assert.deepEqual(
    results.map(({ shipping }) => shipping.costCharged),
    [12_000, 12_000, 0],
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
        { secret: TEST_SECRET, now: NOW, markupPercent: 0 },
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
        { secret: TEST_SECRET, now: NOW, markupPercent: 0 },
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
        { secret: TEST_SECRET, now: NOW, markupPercent: 0 },
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
        { secret: TEST_SECRET, now: NOW + 31 * 60 * 1000, markupPercent: 0 },
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
    { secret: TEST_SECRET, now: NOW, settings, markupPercent: 0 },
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
        { secret: TEST_SECRET, now: NOW, settings: settingsAtOrderCreationTime, markupPercent: 0 },
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
        { secret: TEST_SECRET, now: NOW, settings, markupPercent: 0 },
      ),
    CheckoutShippingQuoteError,
  )
})

test("firma vinculada a dirección, sucursal idgla, variante, cantidad y vencimiento exacto", () => {
  const bound = { ...binding, direccion: "San Martín 123", sucursalId: 10055 }
  const costCharged = calculateCustomerShippingCost(10000, 12000, DEFAULT_SHIPPING_SETTINGS)
  const quoteToken = createCheckoutShippingQuoteToken(bound, pricedOption("sucursal", 12000, costCharged), { secret: TEST_SECRET, now: NOW })
  const shipping = { type: "sucursal" as const, quoteToken }
  assert.equal(normalizeCheckoutShipping(shipping, bound, 10000, { secret: TEST_SECRET, now: NOW, markupPercent: 0 }).costReal, 12000)
  for (const changed of [
    { ...bound, direccion: "San Martín 124" }, { ...bound, sucursalId: 10056 },
    { ...bound, sucursalId: null }, { ...bound, provincia: "Santa Fe" },
    { ...bound, items: [{ productId: 10, variantId: 5, quantity: 2 }] },
    { ...bound, items: [{ productId: 10, variantId: 4, quantity: 3 }] },
  ]) {
    assert.throws(() => normalizeCheckoutShipping(shipping, changed, 10000, { secret: TEST_SECRET, now: NOW, markupPercent: 0 }), CheckoutShippingQuoteError)
  }
  assert.throws(() => normalizeCheckoutShipping(shipping, bound, 10000, { secret: TEST_SECRET, now: NOW + 30 * 60 * 1000, markupPercent: 0 }), CheckoutShippingQuoteError)
})

test("token v3: cifrado; el navegador no puede leer tarifa del proveedor ni recargo", () => {
  const quoteToken = createCheckoutShippingQuoteToken(
    binding,
    pricedOption("domicilio", 10_000, undefined, 5),
    { secret: TEST_SECRET, now: NOW },
  )
  const readable = quoteToken.split(".").map((part) => Buffer.from(part, "base64url").toString("latin1")).join(" ")
  assert.doesNotMatch(readable, /providerCents|markup|10000|1000000|beyonix-packing/)
})

test("token v3: recargo y tarifa íntegros; un desglose manipulado no se firma", () => {
  const option = pricedOption("domicilio", 10_000, undefined, 5)
  assert.throws(
    () => createCheckoutShippingQuoteToken(binding, { ...option, pricing: { ...option.pricing, markupAmount: 0 } }, { secret: TEST_SECRET, now: NOW }),
    CheckoutShippingQuoteError,
  )
  assert.throws(
    () => createCheckoutShippingQuoteToken(binding, { ...option, price: 9_000 }, { secret: TEST_SECRET, now: NOW }),
    CheckoutShippingQuoteError,
  )
  assert.throws(
    () => createCheckoutShippingQuoteToken(binding, { ...option, pricing: { ...option.pricing, markupPercent: 60 } }, { secret: TEST_SECRET, now: NOW }),
    CheckoutShippingQuoteError,
  )
})

test("snapshot: la orden recibe tarifa, %, extra, ajuste, beneficio y estimación del token", () => {
  const settings = { ...DEFAULT_SHIPPING_SETTINGS, freeShippingMode: "full" as const, freeShippingMinAmount: 80_000, shippingBonusMax: 2_000, logisticsBaseSubsidy: 0 }
  const option = pricedOption("domicilio", 10_000, undefined, 5)
  const costCharged = calculateCustomerShippingCost(100_000, option.price, settings)
  const quoteToken = createCheckoutShippingQuoteToken(binding, { ...option, costCharged }, { secret: TEST_SECRET, now: NOW })
  const shipping = normalizeCheckoutShipping({ type: "domicilio", quoteToken, costReal: 1 }, binding, 100_000, { secret: TEST_SECRET, now: NOW, settings, markupPercent: 5 })
  assert.deepEqual(shipping.pricing, { providerAmount: 10_000, markupPercent: 5, markupAmount: 500, roundingAmount: 0 })
  assert.equal(shipping.costReal, 10_500)
  assert.equal(shipping.costCharged, 8_500)
  assert.equal(shipping.benefitAmount, 2_000)
  assert.equal(
    shipping.pricing.providerAmount + shipping.pricing.markupAmount + shipping.pricing.roundingAmount,
    shipping.costReal,
  )
  assert.deepEqual(shipping.estimate, ESTIMATE)
})

test("recargo cambiado en Admin entre cotizar y crear la orden: se exige recotizar", () => {
  const quoteToken = createCheckoutShippingQuoteToken(binding, pricedOption("domicilio", 10_000, undefined, 3), { secret: TEST_SECRET, now: NOW })
  assert.throws(
    () => normalizeCheckoutShipping({ type: "domicilio", quoteToken }, binding, 100_000, { secret: TEST_SECRET, now: NOW, settings: DEFAULT_SHIPPING_SETTINGS, markupPercent: 8 }),
    CheckoutShippingQuoteError,
  )
})

test("beneficio con saldo a favor: el envío completo (con recargo) queda absorbido por BEYONIX", () => {
  const quoteToken = createCheckoutShippingQuoteToken(binding, pricedOption("domicilio", 10_000, undefined, 5), { secret: TEST_SECRET, now: NOW })
  const shipping = normalizeCheckoutShipping({ type: "domicilio", quoteToken }, binding, 1_000, { secret: TEST_SECRET, now: NOW, customerCreditApplied: true, markupPercent: 5 })
  assert.equal(shipping.costCharged, 0)
  assert.equal(shipping.freeShippingApplied, true)
  assert.equal(shipping.benefitAmount, 10_500)
  assert.equal(shipping.pricing.markupAmount, 500)
})

test("un token v2 (contenido legible y firma HMAC) ya no se acepta", () => {
  const legacy = `${Buffer.from(JSON.stringify({ version: 2, costCents: 100 })).toString("base64url")}.firma`
  assert.throws(
    () => normalizeCheckoutShipping({ type: "domicilio", quoteToken: legacy }, binding, 100_000, { secret: TEST_SECRET, now: NOW, markupPercent: 0 }),
    CheckoutShippingQuoteError,
  )
})
