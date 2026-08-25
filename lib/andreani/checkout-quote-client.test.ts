import assert from "node:assert/strict"
import test from "node:test"

import {
  buildShippingQuoteKey,
  CheckoutCatalogError,
  getLocalitiesForProvince,
  getPostalCodesForLocality,
  getShippingQuoteOptions,
  isQuotableDestination,
  prefetchCheckoutShippingQuote,
  resetCheckoutQuoteClientStateForTests,
} from "./checkout-quote-client.ts"

interface RecordedRequest {
  url: string
  method: string
}

function installFetchMock(
  handler: (url: string, init?: RequestInit) => Promise<Response> | Response,
) {
  const requests: RecordedRequest[] = []
  const originalFetch = globalThis.fetch

  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = typeof input === "string" ? input : input.toString()
    requests.push({ url, method: init?.method ?? "GET" })
    return handler(url, init)
  }) as typeof fetch

  return {
    requests,
    restore: () => {
      globalThis.fetch = originalFetch
    },
  }
}

const savedItems = [
  { productId: 10, quantity: 2, variantId: null, conditionedStockId: null },
]

const baseQuoteOption = {
  type: "domicilio",
  price: 5000,
  quoteToken: "token-abc",
}

test("buildShippingQuoteKey: provincia con distinto casing genera la misma clave", () => {
  const a = buildShippingQuoteKey({
    cpDestino: "2000",
    localidad: "Rosario",
    provincia: "corrientes",
    items: savedItems,
  })
  const b = buildShippingQuoteKey({
    cpDestino: "2000",
    localidad: "Rosario",
    provincia: "CORRIENTES",
    items: savedItems,
  })

  assert.equal(a, b)
})

test("buildShippingQuoteKey: localidad con/sin tilde genera la misma clave", () => {
  const a = buildShippingQuoteKey({
    cpDestino: "5000",
    localidad: "Córdoba",
    provincia: "Cordoba",
    items: savedItems,
  })
  const b = buildShippingQuoteKey({
    cpDestino: "5000",
    localidad: "CORDOBA",
    provincia: "CORDOBA",
    items: savedItems,
  })

  assert.equal(a, b)
})

test("buildShippingQuoteKey: alias CABA / Capital Federal generan la misma clave", () => {
  const a = buildShippingQuoteKey({
    cpDestino: "1000",
    localidad: "Ciudad Autónoma de Buenos Aires",
    provincia: "CABA",
    items: savedItems,
  })
  const b = buildShippingQuoteKey({
    cpDestino: "1000",
    localidad: "CIUDAD AUTONOMA DE BUENOS AIRES",
    provincia: "Capital Federal",
    items: savedItems,
  })

  assert.equal(a, b)
})

test("buildShippingQuoteKey: mismos ítems en distinto orden generan la misma clave", () => {
  const a = buildShippingQuoteKey({
    cpDestino: "2000",
    localidad: "Rosario",
    provincia: "Santa Fe",
    items: [
      { productId: 1, quantity: 1, variantId: null, conditionedStockId: null },
      { productId: 2, quantity: 3, variantId: 7, conditionedStockId: null },
    ],
  })
  const b = buildShippingQuoteKey({
    cpDestino: "2000",
    localidad: "Rosario",
    provincia: "Santa Fe",
    items: [
      { productId: 2, quantity: 3, variantId: 7, conditionedStockId: null },
      { productId: 1, quantity: 1, variantId: null, conditionedStockId: null },
    ],
  })

  assert.equal(a, b)
})

test("buildShippingQuoteKey: cambiar la cantidad genera una clave distinta", () => {
  const a = buildShippingQuoteKey({
    cpDestino: "2000",
    localidad: "Rosario",
    provincia: "Santa Fe",
    items: [{ productId: 1, quantity: 1, variantId: null, conditionedStockId: null }],
  })
  const b = buildShippingQuoteKey({
    cpDestino: "2000",
    localidad: "Rosario",
    provincia: "Santa Fe",
    items: [{ productId: 1, quantity: 2, variantId: null, conditionedStockId: null }],
  })

  assert.notEqual(a, b)
})

test("buildShippingQuoteKey: cambiar el variantId genera una clave distinta", () => {
  const a = buildShippingQuoteKey({
    cpDestino: "2000",
    localidad: "Rosario",
    provincia: "Santa Fe",
    items: [{ productId: 1, quantity: 1, variantId: 5, conditionedStockId: null }],
  })
  const b = buildShippingQuoteKey({
    cpDestino: "2000",
    localidad: "Rosario",
    provincia: "Santa Fe",
    items: [{ productId: 1, quantity: 1, variantId: 6, conditionedStockId: null }],
  })

  assert.notEqual(a, b)
})

test("buildShippingQuoteKey: cambiar el conditionedStockId genera una clave distinta", () => {
  const a = buildShippingQuoteKey({
    cpDestino: "2000",
    localidad: "Rosario",
    provincia: "Santa Fe",
    items: [
      {
        productId: 1,
        quantity: 1,
        variantId: null,
        conditionedStockId: "11111111-1111-4111-8111-111111111111",
      },
    ],
  })
  const b = buildShippingQuoteKey({
    cpDestino: "2000",
    localidad: "Rosario",
    provincia: "Santa Fe",
    items: [
      {
        productId: 1,
        quantity: 1,
        variantId: null,
        conditionedStockId: "22222222-2222-4222-8222-222222222222",
      },
    ],
  })

  assert.notEqual(a, b)
})

test("isQuotableDestination exige provincia + localidad + CP de 4 dígitos", () => {
  assert.equal(
    isQuotableDestination({
      provincia: "Santa Fe",
      localidad: "Rosario",
      cpDestino: "2000",
    }),
    true,
  )
  assert.equal(
    isQuotableDestination({ provincia: "Santa Fe", localidad: "Rosario", cpDestino: "" }),
    false,
  )
  assert.equal(
    isQuotableDestination({
      provincia: "Santa Fe",
      localidad: "",
      cpDestino: "2000",
    }),
    false,
  )
  assert.equal(
    isQuotableDestination({
      provincia: "Santa Fe",
      localidad: "Rosario",
      cpDestino: "20A0",
    }),
    false,
  )
})

test("fast-path: prefetch con destino guardado completo NO llama a /destinos, solo a /cotizar", async () => {
  resetCheckoutQuoteClientStateForTests()
  const mock = installFetchMock((url) => {
    if (url.includes("/api/andreani/cotizar")) {
      return Response.json({ ok: true, options: [baseQuoteOption] })
    }
    throw new Error(`No debería llamarse: ${url}`)
  })

  try {
    await prefetchCheckoutShippingQuote({
      provincia: "Santa Fe",
      localidad: "Rosario",
      cpDestino: "2000",
      items: [{ product: { id: 10 }, quantity: 2, variantId: null, conditionedStockId: null }],
    })

    assert.equal(mock.requests.length, 1)
    assert.match(mock.requests[0].url, /\/api\/andreani\/cotizar$/)
    assert.equal(mock.requests[0].method, "POST")
  } finally {
    mock.restore()
  }
})

test("CABA guardada: el prefetch cotiza directo sin descargar el catálogo de ~436 CP", async () => {
  resetCheckoutQuoteClientStateForTests()
  const mock = installFetchMock((url) => {
    if (url.includes("/api/andreani/destinos")) {
      throw new Error(
        `El fast-path no debe descargar el catálogo territorial: ${url}`,
      )
    }
    if (url.includes("/api/andreani/cotizar")) {
      return Response.json({ ok: true, options: [baseQuoteOption] })
    }
    throw new Error(`URL inesperada: ${url}`)
  })

  try {
    await prefetchCheckoutShippingQuote({
      provincia: "CABA",
      localidad: "CIUDAD AUTÓNOMA DE BUENOS AIRES",
      cpDestino: "1000",
      items: [{ product: { id: 10 }, quantity: 1, variantId: null, conditionedStockId: null }],
    })

    assert.equal(mock.requests.length, 1)
    assert.match(mock.requests[0].url, /\/api\/andreani\/cotizar$/)
  } finally {
    mock.restore()
  }
})

test("prefetch es un no-op silencioso si el destino guardado está incompleto", async () => {
  resetCheckoutQuoteClientStateForTests()
  const mock = installFetchMock(() => {
    throw new Error("No debería disparar ninguna request")
  })

  try {
    await prefetchCheckoutShippingQuote({
      provincia: "CABA",
      localidad: "",
      cpDestino: "",
      items: [{ product: { id: 10 }, quantity: 1, variantId: null, conditionedStockId: null }],
    })

    assert.equal(mock.requests.length, 0)
  } finally {
    mock.restore()
  }
})

test("dos consumidores concurrentes comparten una única request de cotización", async () => {
  resetCheckoutQuoteClientStateForTests()
  let fetchCalls = 0
  const mock = installFetchMock(async () => {
    fetchCalls += 1
    await new Promise((resolve) => setTimeout(resolve, 10))
    return Response.json({ ok: true, options: [baseQuoteOption] })
  })

  try {
    const destination = {
      cpDestino: "2000",
      localidad: "Rosario",
      provincia: "Santa Fe",
      items: savedItems,
    }

    const [first, second] = await Promise.all([
      getShippingQuoteOptions(destination),
      getShippingQuoteOptions(destination),
    ])

    assert.equal(fetchCalls, 1)
    assert.deepEqual(first, second)
    assert.deepEqual(first, [baseQuoteOption])
  } finally {
    mock.restore()
  }
})

test("una request compartida no se cancela porque un consumidor deje de necesitarla", async () => {
  // No hay AbortSignal por consumidor en la API pública: la única forma de
  // que esto falle sería que la propia implementación aborte la request
  // compartida por su cuenta. Simulamos dos consumidores concurrentes y
  // confirmamos que ambos reciben el resultado real, sin importar el orden
  // en que "dejan de esperar" -- acá el segundo directamente se descarta.
  resetCheckoutQuoteClientStateForTests()
  const mock = installFetchMock(async () => {
    await new Promise((resolve) => setTimeout(resolve, 15))
    return Response.json({ ok: true, options: [baseQuoteOption] })
  })

  try {
    const destination = {
      cpDestino: "2000",
      localidad: "Rosario",
      provincia: "Santa Fe",
      items: savedItems,
    }

    const firstPromise = getShippingQuoteOptions(destination)
    // Segundo consumidor: pide lo mismo y luego "se desentiende" (no espera
    // su resultado). Esto no debe afectar al primero.
    void getShippingQuoteOptions(destination)

    const result = await firstPromise
    assert.deepEqual(result, [baseQuoteOption])
  } finally {
    mock.restore()
  }
})

test("un timeout de Andreani se distingue de un resultado vacío real", async () => {
  resetCheckoutQuoteClientStateForTests()
  const mock = installFetchMock(() =>
    Response.json({ ok: false, message: "Andreani no respondió a tiempo." }, { status: 504 }),
  )

  try {
    await assert.rejects(
      () => getPostalCodesForLocality("CABA", "Ciudad Autónoma de Buenos Aires"),
      (error) => {
        assert.ok(error instanceof CheckoutCatalogError)
        assert.equal(error.reason, "timeout")
        return true
      },
    )
  } finally {
    mock.restore()
  }
})

test("un resultado vacío real de CP no lanza error", async () => {
  resetCheckoutQuoteClientStateForTests()
  const mock = installFetchMock(() =>
    Response.json({ ok: true, locality: "BASE MARAMBIO", postalCodes: [] }),
  )

  try {
    const result = await getPostalCodesForLocality("Tierra del Fuego", "Base Marambio")
    assert.deepEqual(result, { locality: "BASE MARAMBIO", postalCodes: [] })
  } finally {
    mock.restore()
  }
})

test("getLocalitiesForProvince deduplica por clave y cachea el resultado", async () => {
  resetCheckoutQuoteClientStateForTests()
  let fetchCalls = 0
  const mock = installFetchMock(() => {
    fetchCalls += 1
    return Response.json({
      ok: true,
      localities: [{ id: "1", name: "ROSARIO" }],
    })
  })

  try {
    const [a, b] = await Promise.all([
      getLocalitiesForProvince("Santa Fe"),
      getLocalitiesForProvince("SANTA FE"),
    ])

    assert.equal(fetchCalls, 1)
    assert.deepEqual(a, b)
  } finally {
    mock.restore()
  }
})
