import assert from "node:assert/strict"
import test from "node:test"

import { getCheckoutOrderItemUnitPrice } from "../orders/conditioned-checkout.ts"
import { AndreaniError } from "./client.ts"
import {
  getCheckoutPostalCodes,
  getCheckoutProvinceLocalities,
  resetCheckoutDestinationStateForTests,
} from "./checkout-destinations.ts"
import {
  aggregateAndreaniPackage,
  matchAndreaniCheckoutProvince,
  normalizeCheckoutQuoteRequest,
  quoteAndreaniCheckout,
  resetAndreaniCheckoutQuoteStateForTests,
  roundShippingCostToNearestThousand,
  type LoadedCheckoutQuoteItem,
} from "./checkout-quote.ts"

const completeProduct = {
  id: 10,
  nombre: "Producto completo",
  precio: 20_000,
  peso_empaquetado_kg: 1,
  alto_paquete_cm: 10,
  ancho_paquete_cm: 20,
  largo_paquete_cm: 30,
}

const officialLocalityResponse = [
  {
    idDeProvLocalidad: 107362,
    localidad: "PASO DE LOS LIBRES",
    provincia: "CORRIENTES",
    codigosPostales: ["3230"],
  },
]

const officialBranchResponse = [
  {
    id: 10055,
    codigo: "SFN",
    numero: "55",
    descripcion: "SANTA FE (CENTRO)",
    canal: "B2C",
    direccion: {
      calle: "25 de Mayo",
      numero: "3340",
      provincia: "Santa Fe",
      localidad: "Santa Fe",
      region: "Litoral",
      pais: "Argentina",
      codigoPostal: "3000",
    },
  },
]

function qaQuoteEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    ANDREANI_ENV: "QA",
    ANDREANI_QA_API_URL: "https://apisqa.andreani.com",
    ANDREANI_QA_USERNAME: "usuario-prueba",
    ANDREANI_QA_PASSWORD: "clave-prueba",
    ANDREANI_QA_CLIENT: "CLIENTE-QA",
    ANDREANI_QA_HOME_CONTRACT: "CONTRATO-QA",
    ANDREANI_QA_ORIGIN_BRANCH: "RAC",
  }
}

test("redondea el costo de envío al millar usando $300 como punto de corte", () => {
  const cases: Array<[number, number]> = [
    [13_656, 14_000],
    [13_324, 14_000],
    [13_300, 14_000],
    [13_299, 13_000],
    [13_050, 13_000],
    [13_000, 13_000],
    [14_999, 15_000],
    [14_300, 15_000],
    [14_299, 14_000],
    [14_000, 14_000],
  ]

  for (const [rawCost, expected] of cases) {
    assert.equal(
      roundShippingCostToNearestThousand(rawCost),
      expected,
      `${rawCost} debería redondear a ${expected}`,
    )
  }
})

test("redondea el costo de envío exactamente en los límites de $300", () => {
  const cases: Array<[number, number]> = [
    [12_999, 13_000],
    [13_000, 13_000],
    [13_299, 13_000],
    [13_300, 14_000],
    [13_301, 14_000],
    [13_999, 14_000],
    [14_000, 14_000],
    [14_299, 14_000],
    [14_300, 15_000],
  ]

  for (const [rawCost, expected] of cases) {
    assert.equal(
      roundShippingCostToNearestThousand(rawCost),
      expected,
      `${rawCost} debería redondear a ${expected}`,
    )
  }
})

test("redondea tarifas de Andreani con centavos", () => {
  assert.equal(roundShippingCostToNearestThousand(13_854.56), 14_000)
  assert.equal(roundShippingCostToNearestThousand(13_299.99), 13_000)
  assert.equal(roundShippingCostToNearestThousand(13_300.01), 14_000)
  assert.equal(roundShippingCostToNearestThousand(13_000.01), 13_000)
  assert.equal(roundShippingCostToNearestThousand(22_362.66), 23_000)
})

test("agrega peso, volumen y valor declarado de todas las unidades", () => {
  const result = aggregateAndreaniPackage([
    { product: completeProduct, variant: null, quantity: 2, discountPercent: 0 },
    {
      product: { ...completeProduct, id: 11, nombre: "Segundo producto", precio: 10_000 },
      variant: {
        id: 12,
        producto_id: 11,
        nombre: "Variante pesada",
        peso_empaquetado_kg: 2,
        alto_paquete_cm: null,
        ancho_paquete_cm: null,
        largo_paquete_cm: null,
      },
      quantity: 1,
      discountPercent: 10,
    },
  ])

  assert.deepEqual(result, {
    pesoKg: 4,
    volumenCm3: 18_000,
    valorDeclarado: 49_000,
  })
})

test("el valor declarado usa el mismo redondeo unitario que orden_items", () => {
  const unitPrice = getCheckoutOrderItemUnitPrice(10, 10_001, {
    discount_percent: 10,
  })
  const result = aggregateAndreaniPackage([
    {
      product: { ...completeProduct, precio: unitPrice },
      variant: null,
      quantity: 2,
      discountPercent: 0,
    },
  ])

  assert.equal(unitPrice, 9_001)
  assert.equal(result.valorDeclarado, 18_002)
})

test("una variante hereda y sobrescribe campos mediante el resolvedor central", () => {
  const result = aggregateAndreaniPackage([
    {
      product: completeProduct,
      variant: {
        id: 20,
        producto_id: 10,
        nombre: "Variante",
        peso_empaquetado_kg: 2.5,
      },
      quantity: 1,
      discountPercent: 0,
    },
  ])

  assert.deepEqual(result, {
    pesoKg: 2.5,
    volumenCm3: 6_000,
    valorDeclarado: 20_000,
    altoCm: 10,
    anchoCm: 20,
    largoCm: 30,
  })
})

test("no cotiza un producto con logística incompleta", () => {
  assert.throws(
    () =>
      aggregateAndreaniPackage([
        {
          product: {
            ...completeProduct,
            nombre: "Producto incompleto",
            largo_paquete_cm: null,
          },
          variant: null,
          quantity: 1,
          discountPercent: 0,
        },
      ]),
    (error) =>
      error instanceof AndreaniError &&
      error.code === "VALIDATION_ERROR" &&
      error.message.includes("Producto incompleto"),
  )
})

test("la cotización usa el paquete agregado, normalizando espacios de la localidad real", async () => {
  resetAndreaniCheckoutQuoteStateForTests()
  let receivedWeight = 0
  let receivedVolume = 0
  const loadedItems: LoadedCheckoutQuoteItem[] = [
    { product: completeProduct, variant: null, quantity: 2, discountPercent: 0 },
  ]

  const options = await quoteAndreaniCheckout(
    {
      cpDestino: "3230",
      localidad: "  paso   de los   libres  ",
      provincia: "Corrientes",
      items: [{ productId: 10, quantity: 2 }],
    },
    {
      env: qaQuoteEnvironment(),
      getLocalities: async (filters) => {
        assert.deepEqual(filters, { codigosPostales: "3230" })
        return officialLocalityResponse
      },
      loadItems: async (request) => {
        assert.equal(request.localidad, "PASO DE LOS LIBRES")
        return loadedItems
      },
      quoteTariff: async (input) => {
        receivedWeight = input.bultos[0].kilos ?? 0
        receivedVolume = input.bultos[0].volumen
        assert.equal(input.cpDestino, "3230")
        assert.equal(input.contrato, "CONTRATO-QA")
        assert.equal(input.sucursalOrigen, "RAC")
        return {
          pesoAforado: "2",
          tarifaSinIva: { seguroDistribucion: "0", distribucion: "13400", total: "13400" },
          tarifaConIva: { seguroDistribucion: "0", distribucion: "13500", total: "13500" },
        }
      },
    },
  )

  assert.equal(receivedWeight, 2)
  assert.equal(receivedVolume, 12_000)
  assert.deepEqual(options, [{ type: "domicilio", price: 14_000 }])
})

test("el checkout valida en QA y limita PROD a login y GET de tarifas", async () => {
  resetAndreaniCheckoutQuoteStateForTests()
  const requests: Array<{ url: string; method: string; token: string | null }> = []
  const options = await quoteAndreaniCheckout(
    {
      cpDestino: "3013",
      localidad: "San Carlos Centro",
      provincia: "Santa Fe",
      items: [{ productId: 50, quantity: 1 }],
    },
    {
      env: {
        NODE_ENV: "test",
        ANDREANI_ENV: "QA",
        ANDREANI_TARIFF_ENV: "PROD",
        ANDREANI_QA_API_URL: "https://apisqa.andreani.com",
        ANDREANI_QA_USERNAME: "usuario-qa-prueba",
        ANDREANI_QA_PASSWORD: "clave-qa-prueba",
        ANDREANI_PROD_API_URL: "https://apis.andreani.com",
        ANDREANI_PROD_USERNAME: "usuario-prod-prueba",
        ANDREANI_PROD_PASSWORD: "clave-prod-prueba",
        ANDREANI_PROD_CLIENT: "CLIENTE-PROD",
        ANDREANI_PROD_HOME_CONTRACT: "CONTRATO-PROD",
        ANDREANI_PROD_ORIGIN_BRANCH: "RAC",
      },
      loadItems: async () => [
        {
          product: {
            id: 50,
            nombre: "Producto de prueba",
            precio: 50_000,
            peso_empaquetado_kg: 10,
            alto_paquete_cm: 10,
            ancho_paquete_cm: 10,
            largo_paquete_cm: 10,
          },
          variant: null,
          quantity: 1,
          discountPercent: 0,
        },
      ],
      clientOptions: {
        fetch: async (input, init) => {
          const url = String(input)
          requests.push({
            url,
            method: init?.method ?? "GET",
            token: new Headers(init?.headers).get("x-authorization-token"),
          })
          if (url.endsWith("/login")) {
            return Response.json({ token: "token-prod-prueba" })
          }
          if (new URL(url).pathname === "/v1/localidades") {
            return Response.json([
              {
                idDeProvLocalidad: 1,
                localidad: "SAN CARLOS CENTRO",
                provincia: "SANTA FE",
                codigosPostales: ["3013"],
              },
            ])
          }
          return Response.json({
            pesoAforado: "10000.00",
            tarifaSinIva: {
              seguroDistribucion: "0.00",
              distribucion: "18481.54",
              total: "18481.54",
            },
            tarifaConIva: {
              seguroDistribucion: "0.00",
              distribucion: "22362.66",
              total: "22362.66",
            },
          })
        },
      },
    },
  )

  assert.equal(requests.length, 3)
  assert.equal(new URL(requests[0].url).hostname, "apisqa.andreani.com")
  assert.equal(new URL(requests[0].url).pathname, "/v1/localidades")
  assert.equal(requests[0].method, "GET")
  assert.equal(new URL(requests[1].url).pathname, "/login")
  assert.equal(requests[1].method, "GET")
  const tariffUrl = new URL(requests[2].url)
  assert.equal(tariffUrl.pathname, "/v1/tarifas")
  assert.equal(requests[2].method, "GET")
  assert.equal(requests[2].token, "token-prod-prueba")
  assert.equal(tariffUrl.searchParams.get("contrato"), "CONTRATO-PROD")
  assert.equal(tariffUrl.searchParams.get("cliente"), "CLIENTE-PROD")
  assert.equal(tariffUrl.searchParams.get("sucursalOrigen"), "RAC")
  assert.equal(tariffUrl.searchParams.get("cpDestino"), "3013")
  assert.equal(tariffUrl.searchParams.get("bultos[0][kilos]"), "10")
  assert.equal(tariffUrl.searchParams.get("bultos[0][volumen]"), "1000")
  assert.equal(tariffUrl.searchParams.get("bultos[0][valorDeclarado]"), "50000")
  assert.deepEqual(options, [{ type: "domicilio", price: 23_000 }])
})

test("reutiliza localidades estables para el mismo código postal", async () => {
  resetAndreaniCheckoutQuoteStateForTests()
  let localityRequests = 0
  const request = {
    cpDestino: "3230",
    localidad: "Paso de los Libres",
    provincia: "Corrientes",
    items: [{ productId: 10, quantity: 1 }],
  }
  const dependencies = {
    env: qaQuoteEnvironment(),
    loadItems: async () => [
      {
        product: completeProduct,
        variant: null,
        quantity: 1,
        discountPercent: 0,
      },
    ],
    quoteTariff: async () => ({
      pesoAforado: "1",
      tarifaSinIva: { seguroDistribucion: "0", distribucion: "100", total: "100" },
      tarifaConIva: { seguroDistribucion: "0", distribucion: "121", total: "121" },
    }),
    clientOptions: {
      fetch: async () => {
        localityRequests += 1
        return Response.json(officialLocalityResponse)
      },
    },
  }

  await quoteAndreaniCheckout(request, dependencies)
  await quoteAndreaniCheckout(request, dependencies)

  assert.equal(localityRequests, 1)
})

test("reutiliza el destino ya resuelto antes de cotizar", async () => {
  resetAndreaniCheckoutQuoteStateForTests()
  resetCheckoutDestinationStateForTests()
  await getCheckoutPostalCodes("Corrientes", "Paso de los Libres", {
    fetch: async () =>
      Response.json({
        asentamientos: [{ id: "18021010", nombre: "Paso de los Libres" }],
      }),
    getAndreaniLocalities: async () => officialLocalityResponse,
  })

  let duplicateLocalityRequests = 0
  const options = await quoteAndreaniCheckout(
    {
      cpDestino: "3230",
      localidad: "Paso de los Libres",
      provincia: "Corrientes",
      items: [{ productId: 10, quantity: 1 }],
    },
    {
      env: qaQuoteEnvironment(),
      getLocalities: async () => {
        duplicateLocalityRequests += 1
        return officialLocalityResponse
      },
      loadItems: async () => [
        {
          product: completeProduct,
          variant: null,
          quantity: 1,
          discountPercent: 0,
        },
      ],
      quoteTariff: async () => ({
        pesoAforado: "1",
        tarifaSinIva: { seguroDistribucion: "0", distribucion: "13400", total: "13400" },
        tarifaConIva: { seguroDistribucion: "0", distribucion: "13500", total: "13500" },
      }),
    },
  )

  assert.equal(duplicateLocalityRequests, 0)
  assert.deepEqual(options, [{ type: "domicilio", price: 14_000 }])
})

test("deduplica cotizaciones simultáneas idénticas", async () => {
  resetAndreaniCheckoutQuoteStateForTests()
  let tariffRequests = 0
  const request = {
    cpDestino: "3230",
    localidad: "Paso de los Libres",
    provincia: "Corrientes",
    items: [{ productId: 10, quantity: 1 }],
  }
  const dependencies = {
    env: qaQuoteEnvironment(),
    isDestinationCached: () => true,
    loadItems: async () => [
      {
        product: completeProduct,
        variant: null,
        quantity: 1,
        discountPercent: 0,
      },
    ],
    quoteTariff: async () => {
      tariffRequests += 1
      await new Promise<void>((resolve) => setImmediate(resolve))
      return {
        pesoAforado: "1",
        tarifaSinIva: { seguroDistribucion: "0", distribucion: "100", total: "100" },
        tarifaConIva: { seguroDistribucion: "0", distribucion: "121", total: "121" },
      }
    },
  }

  const [first, second] = await Promise.all([
    quoteAndreaniCheckout(request, dependencies),
    quoteAndreaniCheckout(request, dependencies),
  ])

  assert.equal(tariffRequests, 1)
  assert.deepEqual(second, first)
})

test("valida provincia, localidad y código postal ignorando mayúsculas y tildes", () => {
  const locality = matchAndreaniCheckoutProvince(
    {
      cpDestino: "3230",
      provincia: "Corrientes",
      localidad: "Paso de los Libres",
    },
    officialLocalityResponse,
  )

  assert.equal(locality.localidad, "PASO DE LOS LIBRES")
  assert.equal(locality.provincia, "CORRIENTES")
})

test("rechaza una localidad arbitraria aunque CP y provincia sean válidos", () => {
  assert.throws(
    () =>
      matchAndreaniCheckoutProvince(
        {
          cpDestino: "3230",
          provincia: "Corrientes",
          localidad: "Mendoza",
        },
        officialLocalityResponse,
      ),
    (error) =>
      error instanceof AndreaniError &&
      error.code === "VALIDATION_ERROR" &&
      error.message === "La localidad no corresponde al código postal indicado.",
  )
})

test("acepta el alias CABA / Capital Federal como misma localidad", () => {
  const locality = matchAndreaniCheckoutProvince(
    {
      cpDestino: "1000",
      provincia: "CABA",
      localidad: "Ciudad Autónoma de Buenos Aires",
    },
    [
      {
        idDeProvLocalidad: 1,
        localidad: "CIUDAD AUTONOMA DE BUENOS AIRES",
        provincia: "CAPITAL FEDERAL",
        codigosPostales: ["1000"],
      },
    ],
  )

  assert.equal(locality.provincia, "CAPITAL FEDERAL")
})

test("consulta sucursales B2C antes de ofrecer esa modalidad", async () => {
  resetAndreaniCheckoutQuoteStateForTests()
  let branchFilters: unknown
  const options = await quoteAndreaniCheckout(
    {
      cpDestino: "3230",
      localidad: "PASO DE LOS LIBRES",
      provincia: "CORRIENTES",
      items: [{ productId: 10, quantity: 1 }],
    },
    {
      env: {
        ...qaQuoteEnvironment(),
        ANDREANI_QA_BRANCH_CONTRACT: "CONTRATO-SUCURSAL-QA",
      },
      getLocalities: async () => officialLocalityResponse,
      getBranches: async (filters) => {
        branchFilters = filters
        return officialBranchResponse
      },
      loadItems: async () => [
        {
          product: completeProduct,
          variant: null,
          quantity: 1,
          discountPercent: 0,
        },
      ],
      quoteTariff: async (input) => ({
        pesoAforado: "1",
        tarifaSinIva: {
          seguroDistribucion: "0",
          distribucion: "13400",
          total: "13400",
        },
        tarifaConIva: {
          seguroDistribucion: "0",
          distribucion: "13500",
          total:
            input.contrato === "CONTRATO-SUCURSAL-QA" ? "13100" : "13500",
        },
      }),
    },
  )

  assert.deepEqual(branchFilters, {
    codigoPostal: "3230",
    canal: "B2C",
    seHaceAtencionAlCliente: true,
  })
  assert.deepEqual(options, [
    { type: "domicilio", price: 14_000 },
    { type: "sucursal", price: 13_000 },
  ])
})

test("bloquea Tierra del Fuego con CP 9400 antes de acceder al carrito", async () => {
  resetAndreaniCheckoutQuoteStateForTests()
  let itemsWereLoaded = false

  await assert.rejects(
    () =>
      quoteAndreaniCheckout(
        {
          cpDestino: "9400",
          localidad: "RÍO GRANDE",
          provincia: "TIERRA DEL FUEGO",
          items: [{ productId: 10, quantity: 1 }],
        },
        {
          env: qaQuoteEnvironment(),
          getLocalities: async () => [
            {
              idDeProvLocalidad: 24899,
              localidad: "RÍO GALLEGOS",
              provincia: "SANTA CRUZ",
              codigosPostales: ["9400"],
            },
          ],
          loadItems: async () => {
            itemsWereLoaded = true
            return []
          },
        },
      ),
    (error) =>
      error instanceof AndreaniError &&
      error.code === "VALIDATION_ERROR" &&
      error.message ===
        "El código postal no corresponde a la provincia seleccionada.",
  )
  assert.equal(itemsWereLoaded, false)
})

test("bloquea con destino no disponible cuando Andreani no devuelve tarifa", async () => {
  resetAndreaniCheckoutQuoteStateForTests()

  await assert.rejects(
    () =>
      quoteAndreaniCheckout(
        {
          cpDestino: "3230",
          localidad: "Paso de los Libres",
          provincia: "Corrientes",
          items: [{ productId: 10, quantity: 1 }],
        },
        {
          env: qaQuoteEnvironment(),
          getLocalities: async () => officialLocalityResponse,
          loadItems: async () => [
            {
              product: completeProduct,
              variant: null,
              quantity: 1,
              discountPercent: 0,
            },
          ],
          quoteTariff: async () => ({
            pesoAforado: "1",
            tarifaSinIva: {
              seguroDistribucion: "0",
              distribucion: "0",
              total: "0",
            },
            tarifaConIva: {
              seguroDistribucion: "0",
              distribucion: "0",
              total: "0",
            },
          }),
        },
      ),
    (error) =>
      error instanceof AndreaniError &&
      error.code === "VALIDATION_ERROR" &&
      error.message ===
        "No encontramos envío disponible para este destino.",
  )
})

test("normaliza la localidad para guardar y mostrar sin quitar tildes", () => {
  const request = normalizeCheckoutQuoteRequest({
    cpDestino: "9420",
    localidad: "  río   grande  ",
    provincia: "Tierra del Fuego",
    items: [{ productId: 10, quantity: 1 }],
  })

  assert.equal(request.localidad, "RÍO GRANDE")

  const quoteWithoutLocality = normalizeCheckoutQuoteRequest({
    cpDestino: "9420",
    provincia: "Tierra del Fuego",
    items: [{ productId: 10, quantity: 1 }],
  })
  assert.equal(quoteWithoutLocality.localidad, "")
})

test("Georef aporta localidades por provincia y se cachea durante la sesión", async () => {
  resetCheckoutDestinationStateForTests()
  let georefRequests = 0
  const dependencies = {
    fetch: async () => {
      georefRequests += 1
      return Response.json({
        asentamientos: [
          { id: "94015020", nombre: "Ushuaia" },
          { id: "94008010", nombre: "Río Grande" },
          { id: "94008011", nombre: "RIO GRANDE" },
        ],
      })
    },
  }

  const [first, second] = await Promise.all([
    getCheckoutProvinceLocalities("Tierra del Fuego", dependencies),
    getCheckoutProvinceLocalities("TIERRA DEL FUEGO", dependencies),
  ])

  assert.equal(georefRequests, 1)
  assert.deepEqual(first, [
    { id: "94008010", name: "RÍO GRANDE" },
    { id: "94015020", name: "USHUAIA" },
  ])
  assert.deepEqual(second, first)
})

test("Andreani define los CP de la localidad y descarta otras provincias", async () => {
  resetCheckoutDestinationStateForTests()
  let andreaniRequests = 0
  const dependencies = {
    fetch: async () =>
      Response.json({
        asentamientos: [{ id: "94015020", nombre: "Ushuaia" }],
      }),
    getAndreaniLocalities: async () => {
      andreaniRequests += 1
      return [
        {
          idDeProvLocalidad: 1,
          localidad: "USHUAIA",
          provincia: "TIERRA DEL FUEGO",
          codigosPostales: ["9413", "9410"],
        },
        {
          idDeProvLocalidad: 2,
          localidad: "USHUAIA",
          provincia: "SANTA CRUZ",
          codigosPostales: ["9400"],
        },
      ]
    },
  }

  const [first, second] = await Promise.all([
    getCheckoutPostalCodes("Tierra del Fuego", "Ushuaia", dependencies),
    getCheckoutPostalCodes("Tierra del Fuego", "USHUAIA", dependencies),
  ])

  assert.equal(andreaniRequests, 1)
  assert.deepEqual(first, {
    locality: "USHUAIA",
    postalCodes: ["9410", "9413"],
  })
  assert.deepEqual(second, first)
})

test("CABA se presenta como una única ciudad compatible con Andreani", async () => {
  resetCheckoutDestinationStateForTests()
  const localities = await getCheckoutProvinceLocalities("CABA", {
    fetch: async () =>
      Response.json({
        asentamientos: [
          { id: "02007010", nombre: "CABA - Comuna 1" },
          { id: "02014010", nombre: "CABA - Comuna 2" },
        ],
      }),
  })

  assert.deepEqual(localities, [
    { id: "02", name: "CIUDAD AUTÓNOMA DE BUENOS AIRES" },
  ])
})

test("CABA resuelve códigos postales aunque Andreani identifique la provincia como CAPITAL FEDERAL", async () => {
  resetCheckoutDestinationStateForTests()
  // Regresión: Andreani no tiene una entrada de localidad por barrio para
  // CABA (buscar "Recoleta"/"Caballito" no devuelve nada) -- toda la
  // ciudad es una única localidad, y Andreani la etiqueta con la provincia
  // histórica "Capital Federal", no "CABA" (verificado contra QA en vivo).
  // Si `normalizeArgentineProvinceKey` no equiparara ambos valores, este
  // filtro descartaría los ~436 CP reales y el checkout mostraría "sin
  // códigos postales disponibles" pese a que Andreani sí tiene cobertura.
  const dependencies = {
    fetch: async () =>
      Response.json({
        asentamientos: [{ id: "0200701002", nombre: "Monserrat" }],
      }),
    getAndreaniLocalities: async () => [
      {
        idDeProvLocalidad: 1,
        localidad: "CIUDAD AUTONOMA DE BUENOS AIRES",
        provincia: "CAPITAL FEDERAL",
        codigosPostales: ["1000"],
      },
      {
        idDeProvLocalidad: 2,
        localidad: "CIUDAD AUTONOMA DE BUENOS AIRES",
        provincia: "CAPITAL FEDERAL",
        codigosPostales: ["1425"],
      },
    ],
  }

  const result = await getCheckoutPostalCodes(
    "CABA",
    "CIUDAD AUTÓNOMA DE BUENOS AIRES",
    dependencies,
  )

  assert.deepEqual(result, {
    locality: "CIUDAD AUTÓNOMA DE BUENOS AIRES",
    postalCodes: ["1000", "1425"],
  })
})

test("valida el código postal y las cantidades antes de acceder a Supabase", () => {
  assert.throws(
    () =>
      normalizeCheckoutQuoteRequest({
        cpDestino: "ABC",
        localidad: "Rosario",
        provincia: "Santa Fe",
        items: [{ productId: 10, quantity: Number.NaN }],
      }),
    (error) => error instanceof AndreaniError && error.code === "VALIDATION_ERROR",
  )
})
