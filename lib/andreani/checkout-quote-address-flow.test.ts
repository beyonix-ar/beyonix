import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  buildShippingQuoteCacheKey,
  buildShippingQuoteKey,
  getShippingQuoteOptions,
  mapCartItemsToQuoteItems,
  resetCheckoutQuoteClientStateForTests,
  type CheckoutQuoteDestinationInput,
} from "./checkout-quote-client.ts"
import { CheckoutShippingQuoteError, createCheckoutShippingQuoteToken } from "../cart/checkout-shipping.ts"
import { normalizeCheckoutOrderItems, normalizeCheckoutOrderShipping } from "../orders/checkout-order-creation.ts"

// Flujo interno completo con una dirección real con tildes y puntuación:
// clave normalizada (sólo caché/comparación) -> cotización con la dirección
// REAL -> token firmado como lo hace /api/andreani/cotizar -> pedido con la
// dirección del cliente (+ referencias) -> validación del token.

const QUOTE_SECRET = "beyonix-checkout-quote-address-flow-test-secret"
const ORIGINAL_ADDRESS = "Av. Colón 1234, Piso 2"
const QUOTE_OPTION = {
  type: "domicilio" as const,
  price: 42_860,
  costCharged: 17_860,
  pricing: { providerAmount: 42_860, markupPercent: 0, markupAmount: 0, roundingAmount: 0 },
  estimate: {
    version: "beyonix-packing-v1",
    parcels: [{ lengthCm: 22, widthCm: 12, heightCm: 12, volumeCm3: 3_168, weightKg: 2.15 }],
    productsWeightKg: 2,
    productsVolumeCm3: 2_000,
  },
}
const SHIPPING_SETTINGS = {
  defaultShippingCost: 0,
  freeShippingMinAmount: 100_000,
  shippingBonusMax: 25_000,
  freeShippingMode: "full" as const,
  logisticsBaseSubsidy: 0,
}

const formData = { cpDestino: "5000", localidad: "Córdoba", provincia: "Córdoba", direccion: ORIGINAL_ADDRESS }
const cartItems = [{ product: { id: 1 }, quantity: 1, variantId: 11, conditionedStockId: null }]

// Igual que `shippingQuoteDestination` del checkout.
const destination: CheckoutQuoteDestinationInput = {
  cpDestino: formData.cpDestino.trim(),
  localidad: formData.localidad.trim(),
  provincia: formData.provincia.trim(),
  direccion: formData.direccion,
  items: mapCartItemsToQuoteItems(cartItems as never),
}

function withQuoteServer<T>(run: (requests: Array<Record<string, unknown>>) => Promise<T>) {
  const previousFetch = globalThis.fetch
  const previousSecret = process.env.CHECKOUT_SHIPPING_QUOTE_SECRET
  process.env.CHECKOUT_SHIPPING_QUOTE_SECRET = QUOTE_SECRET
  const requests: Array<Record<string, unknown>> = []
  // Igual que /api/andreani/cotizar: firma el token con el payload recibido.
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body)) as Record<string, unknown>
    requests.push(payload)
    const quoteToken = createCheckoutShippingQuoteToken({ ...payload, sucursalId: null } as never, QUOTE_OPTION)
    return Response.json({ ok: true, options: [{ type: "domicilio", price: QUOTE_OPTION.price, costCharged: QUOTE_OPTION.costCharged, quoteToken }] })
  }) as typeof fetch
  resetCheckoutQuoteClientStateForTests()
  return run(requests).finally(() => {
    globalThis.fetch = previousFetch
    resetCheckoutQuoteClientStateForTests()
    if (previousSecret === undefined) delete process.env.CHECKOUT_SHIPPING_QUOTE_SECRET
    else process.env.CHECKOUT_SHIPPING_QUOTE_SECRET = previousSecret
  })
}

function validateOrder(quoteToken: string, customerAddress: string) {
  return normalizeCheckoutOrderShipping({
    shipping: { provider: "andreani", type: "domicilio", quoteToken },
    // Como submitCheckout: dirección del formulario + ". Referencias: …".
    customer: { ...formData, direccion: customerAddress },
    items: normalizeCheckoutOrderItems([{ productId: 1, quantity: 1, variantId: 11 }]),
    productsTotal: 129_500,
    settings: SHIPPING_SETTINGS,
    markupPercent: 0,
  })
}

test("e2e: clave normalizada, cotización con la dirección real, token y pedido compatibles", async () => {
  await withQuoteServer(async (requests) => {
    // 1. La clave normaliza la dirección sólo para comparar (conserva la puntuación).
    const key = JSON.parse(buildShippingQuoteKey(destination)) as { direccion: string }
    assert.equal(key.direccion, "av. colon 1234, piso 2")

    // 2. La cotización viaja con la dirección REAL, intacta.
    const [option] = await getShippingQuoteOptions({ ...destination, calle: "Av. Colón", numero: "1234" })
    assert.equal(requests.length, 1)
    assert.equal(requests[0].direccion, ORIGINAL_ADDRESS)
    assert.equal(requests[0].localidad, "Córdoba")
    assert.equal(requests[0].provincia, "Córdoba")
    assert.equal(requests[0].cpDestino, "5000")

    // 3-5. El pedido usa la dirección del cliente (con referencias) y el token valida.
    const shipping = validateOrder(option.quoteToken!, `${ORIGINAL_ADDRESS}. Referencias: Timbre 2`)
    assert.equal(shipping.costReal, 42_860)
    assert.equal(shipping.costCharged, 17_860)
    assert.equal(validateOrder(option.quoteToken!, ORIGINAL_ADDRESS).costReal, 42_860)
  })
})

test("e2e: la misma dirección sin tilde comparte clave, pero cada cotización firma lo que escribió el cliente", async () => {
  await withQuoteServer(async (requests) => {
    const withoutAccent = { ...destination, direccion: "Av. Colon 1234, Piso 2" }
    assert.equal(buildShippingQuoteKey(withoutAccent), buildShippingQuoteKey(destination))

    const [option] = await getShippingQuoteOptions(withoutAccent)
    assert.equal(requests[0].direccion, "Av. Colon 1234, Piso 2")
    assert.equal(validateOrder(option.quoteToken!, "Av. Colon 1234, Piso 2").costReal, 42_860)
  })
})

test("e2e: firmar con la dirección de la clave normalizada rompe la validación del pedido (por eso no se reutiliza)", () => {
  const previousSecret = process.env.CHECKOUT_SHIPPING_QUOTE_SECRET
  process.env.CHECKOUT_SHIPPING_QUOTE_SECRET = QUOTE_SECRET
  try {
    const keyPayload = JSON.parse(buildShippingQuoteKey(destination)) as Record<string, unknown>
    const tokenFromKey = createCheckoutShippingQuoteToken({ ...keyPayload, sucursalId: null } as never, QUOTE_OPTION)
    assert.throws(() => validateOrder(tokenFromKey, ORIGINAL_ADDRESS), CheckoutShippingQuoteError)
  } finally {
    if (previousSecret === undefined) delete process.env.CHECKOUT_SHIPPING_QUOTE_SECRET
    else process.env.CHECKOUT_SHIPPING_QUOTE_SECRET = previousSecret
  }
})

test("contrato: el checkout cotiza con el destino real, nunca reconstruido desde la clave", () => {
  const checkout = readFileSync(new URL("../../app/checkout/page.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n")
  assert.doesNotMatch(checkout, /JSON\.parse\(shippingQuotePayload\)/)
  assert.match(checkout, /latestShippingQuoteDestinationRef\.current = shippingQuoteDestination\n/)
  assert.match(checkout, /const payload = latestShippingQuoteDestinationRef\.current\n/)
  assert.match(checkout, /const requestPayload = \{ \.\.\.payload, \.\.\.latestStreetAddressRef\.current \}/)
  assert.match(checkout, /getShippingQuoteOptions\(requestPayload\)/)
  // La clave estricta (la de la firma) dispara la cotización; la huella UX
  // sigue siendo la del 409.
  assert.match(checkout, /const shippingQuoteCacheKey = buildShippingQuoteCacheKey\(shippingQuoteDestination\)\n/)
  assert.match(checkout, /\}, \[isDestinationQuotable, shippingQuoteCacheKey\]\)/)
  assert.match(checkout, /destinationKey: shippingQuotePayload,/)
})

// Caché real: sin resetear entre pasos. La huella UX puede considerar iguales
// dos escrituras, pero el caché sólo entrega un token si la firma las trata igual.
async function quoteThenChangeAddress(firstAddress: string, secondAddress: string) {
  await withQuoteServer(async (requests) => {
    const first = { ...destination, direccion: firstAddress }
    const second = { ...destination, direccion: secondAddress }

    const [optionA] = await getShippingQuoteOptions(first)
    assert.equal(requests.length, 1)

    // La huella UX (409) sigue igual; la clave del caché/token no.
    assert.equal(buildShippingQuoteKey(second), buildShippingQuoteKey(first))
    assert.notEqual(buildShippingQuoteCacheKey(second), buildShippingQuoteCacheKey(first))

    const [optionB] = await getShippingQuoteOptions(second)
    assert.equal(requests.length, 2, "debe recotizar en vez de devolver el token anterior")
    assert.equal(requests[1].direccion, secondAddress)
    assert.notEqual(optionB.quoteToken, optionA.quoteToken)

    // El token A nunca valida el pedido B; el token B sí.
    assert.throws(() => validateOrder(optionA.quoteToken!, secondAddress), CheckoutShippingQuoteError)
    const shipping = validateOrder(optionB.quoteToken!, `${secondAddress}. Referencias: Timbre 2`)
    assert.equal(shipping.costReal, 42_860)
    assert.equal(shipping.costCharged, 17_860)

    // La entrada original sigue vigente para su propia escritura.
    const [againA] = await getShippingQuoteOptions(first)
    assert.equal(requests.length, 2)
    assert.equal(againA.quoteToken, optionA.quoteToken)
    assert.equal(validateOrder(againA.quoteToken!, firstAddress).costReal, 42_860)
  })
}

test("caché real: Av. Colón -> Av. Colon recotiza y el nuevo token valida el pedido", async () => {
  await quoteThenChangeAddress("Av. Colón 1234", "Av. Colon 1234")
})

test("caché real: Peña -> Pena recotiza y no reutiliza el token incompatible", async () => {
  await quoteThenChangeAddress("Peña 500", "Pena 500")
})

test("caché real: la misma dirección exacta reutiliza la cotización y su token sigue válido", async () => {
  await withQuoteServer(async (requests) => {
    const [first] = await getShippingQuoteOptions(destination)
    const [second] = await getShippingQuoteOptions({ ...destination })
    assert.equal(requests.length, 1)
    assert.equal(second.quoteToken, first.quoteToken)
    assert.equal(validateOrder(second.quoteToken!, ORIGINAL_ADDRESS).costReal, 42_860)
  })
})

test("caché real: mayúsculas y espacios que la firma ignora reutilizan un token válido", async () => {
  await withQuoteServer(async (requests) => {
    const [first] = await getShippingQuoteOptions({ ...destination, direccion: "Av. Colón 1234" })
    const variant = "  AV. COLÓN   1234 "
    const [second] = await getShippingQuoteOptions({ ...destination, direccion: variant })
    assert.equal(requests.length, 1)
    assert.equal(second.quoteToken, first.quoteToken)
    assert.equal(validateOrder(second.quoteToken!, variant).costReal, 42_860)
  })
})

test("invariante: dos direcciones con la misma clave de caché siempre validan el mismo token", () => {
  const previousSecret = process.env.CHECKOUT_SHIPPING_QUOTE_SECRET
  process.env.CHECKOUT_SHIPPING_QUOTE_SECRET = QUOTE_SECRET
  try {
    const variants = [
      "Av. Colón 1234", "Av. Colon 1234", "AV. COLÓN 1234", " av.  colón 1234 ", "Av. Colón 1234",
      "Peña 500", "Pena 500", "PEÑA 500", "Güemes 10", "Guemes 10",
      "Av. Colón 1234. Referencias: Timbre 2",
    ]
    for (const quoted of variants) {
      const token = createCheckoutShippingQuoteToken({ ...destination, direccion: quoted, sucursalId: null }, QUOTE_OPTION)
      for (const ordered of variants) {
        const sameCacheEntry =
          buildShippingQuoteCacheKey({ ...destination, direccion: quoted }) ===
          buildShippingQuoteCacheKey({ ...destination, direccion: ordered })
        let valid = true
        try {
          validateOrder(token, ordered)
        } catch (error) {
          assert.ok(error instanceof CheckoutShippingQuoteError)
          valid = false
        }
        assert.equal(valid, sameCacheEntry, `${quoted} -> ${ordered}`)
      }
    }
  } finally {
    if (previousSecret === undefined) delete process.env.CHECKOUT_SHIPPING_QUOTE_SECRET
    else process.env.CHECKOUT_SHIPPING_QUOTE_SECRET = previousSecret
  }
})
