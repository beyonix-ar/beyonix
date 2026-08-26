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
  resolveVerifiedAndreaniBranch,
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

const officialBranchResponsePasoDeLosLibres = [
  {
    id: 20011,
    codigo: "PLB",
    numero: "11",
    descripcion: "PASO DE LOS LIBRES (CENTRO)",
    canal: "B2C",
    direccion: {
      calle: "Colón",
      numero: "850",
      provincia: "CORRIENTES",
      localidad: "PASO DE LOS LIBRES",
      region: "Litoral",
      pais: "Argentina",
      codigoPostal: "3230",
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

test("caché de catálogo nacional: una sola consulta a Andreani sirve para Rosario, CABA y repeticiones, sin mezclar destinos", async () => {
  resetAndreaniCheckoutQuoteStateForTests()
  let sucursalesRequests = 0
  const rosarioBranch = {
    id: 10044,
    codigo: "ROS",
    numero: "44",
    descripcion: "ROSARIO (AV SAN MARTIN)",
    canal: "B2C",
    direccion: {
      calle: "San Martín",
      numero: "2127",
      provincia: "Santa Fe",
      localidad: "Rosario",
      region: "Litoral",
      pais: "Argentina",
      codigoPostal: "2000",
    },
  }
  const cabaBranch = {
    id: 10010,
    codigo: "PAL",
    numero: "10",
    descripcion: "PALERMO (AV SCALABRINI ORTIZ)",
    canal: "B2C",
    direccion: {
      calle: "Av Scalabrini Ortiz",
      numero: "1000",
      provincia: "Buenos Aires",
      localidad: "C.a.b.a.",
      region: "Caba",
      pais: "Argentina",
      codigoPostal: "1414",
    },
  }

  const dependencies = {
    env: { ...qaQuoteEnvironment(), ANDREANI_QA_BRANCH_CONTRACT: "CONTRATO-SUCURSAL-QA" },
    geocodeAddress: async () => null,
    loadItems: async () => [
      { product: completeProduct, variant: null, quantity: 1, discountPercent: 0 },
    ],
    quoteTariff: async (input: { contrato: string }) => ({
      pesoAforado: "1",
      tarifaSinIva: { seguroDistribucion: "0", distribucion: "13400", total: "13400" },
      tarifaConIva: {
        seguroDistribucion: "0",
        distribucion: "13500",
        total: input.contrato === "CONTRATO-SUCURSAL-QA" ? "13100" : "13500",
      },
    }),
    // Sin mockear getBranches: usa el AndreaniClient real (vía clientOptions.fetch)
    // para ejercitar el caché de módulo real del catálogo nacional.
    clientOptions: {
      fetch: async (input: string | URL | Request) => {
        const url = new URL(String(input))
        if (url.pathname === "/v1/localidades") {
          const cp = url.searchParams.get("codigosPostales")
          return Response.json(
            cp === "2000"
              ? [{ idDeProvLocalidad: 1, localidad: "ROSARIO", provincia: "SANTA FE", codigosPostales: ["2000"] }]
              : [{ idDeProvLocalidad: 2, localidad: "CIUDAD AUTONOMA DE BUENOS AIRES", provincia: "CAPITAL FEDERAL", codigosPostales: ["1424"] }],
          )
        }
        if (url.pathname === "/v2/sucursales") {
          sucursalesRequests += 1
          // Catálogo nacional único -- sin filtro de localidad -- con
          // sucursales de ambos destinos mezcladas, como devolvería Andreani
          // de verdad.
          assert.equal(url.searchParams.get("localidad"), null)
          assert.equal(url.searchParams.get("canal"), "B2C")
          assert.equal(url.searchParams.get("seHaceAtencionAlCliente"), "true")
          return Response.json([rosarioBranch, cabaBranch])
        }
        throw new Error(`URL inesperada en el test: ${url.pathname}`)
      },
    },
  }

  const rosarioOptions = await quoteAndreaniCheckout(
    {
      cpDestino: "2000",
      localidad: "Rosario",
      provincia: "Santa Fe",
      items: [{ productId: 10, quantity: 1 }],
    },
    dependencies,
  )
  const cabaOptions = await quoteAndreaniCheckout(
    {
      cpDestino: "1424",
      localidad: "Ciudad Autónoma de Buenos Aires",
      provincia: "CABA",
      items: [{ productId: 10, quantity: 1 }],
    },
    dependencies,
  )
  // Repetir Rosario debe reusar el catálogo ya cacheado (no dispara una
  // tercera consulta a Andreani).
  const rosarioOptionsAgain = await quoteAndreaniCheckout(
    {
      cpDestino: "2000",
      localidad: "Rosario",
      provincia: "Santa Fe",
      items: [{ productId: 10, quantity: 1 }],
    },
    dependencies,
  )

  // Una sola consulta al catálogo nacional sirve para los tres destinos.
  assert.equal(sucursalesRequests, 1)
  const rosarioBranches = rosarioOptions.find((o) => o.type === "sucursal")?.branches
  const cabaBranches = cabaOptions.find((o) => o.type === "sucursal")?.branches
  assert.equal(rosarioBranches?.length, 1)
  assert.equal(rosarioBranches?.[0].id, 10044)
  assert.equal(cabaBranches?.length, 1)
  assert.equal(cabaBranches?.[0].id, 10010)
  assert.deepEqual(
    rosarioOptionsAgain.find((o) => o.type === "sucursal")?.branches,
    rosarioBranches,
  )
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

test("matchea la localidad correcta aunque no sea la primera entrada del mismo CP+provincia", () => {
  // Regresión: Andreani puede devolver varias entradas homónimas para el
  // mismo CP+provincia (confirmado en vivo: CP 1424/CABA trae 5 entradas
  // distintas bajo "CAPITAL FEDERAL"). Quedarse con la PRIMERA entrada que
  // matcheaba CP+provincia (sin mirar el nombre) rechazaba destinos válidos
  // cuando la entrada correcta no era la primera de la lista.
  const locality = matchAndreaniCheckoutProvince(
    {
      cpDestino: "1424",
      provincia: "CABA",
      localidad: "Ciudad Autónoma de Buenos Aires",
    },
    [
      { idDeProvLocalidad: 1, localidad: "C.A.B.A.", provincia: "CAPITAL FEDERAL", codigosPostales: ["1424"] },
      { idDeProvLocalidad: 2, localidad: "CIUDAD AUTONOMA BUENOS AIRES", provincia: "CAPITAL FEDERAL", codigosPostales: ["1424"] },
      { idDeProvLocalidad: 3, localidad: "CIUDAD AUTONOMA DE BUENOS AIRES", provincia: "CAPITAL FEDERAL", codigosPostales: ["1424"] },
      { idDeProvLocalidad: 4, localidad: "CABA - PARQUE CHACABUCO", provincia: "CAPITAL FEDERAL", codigosPostales: ["1424"] },
    ],
  )

  assert.equal(locality.localidad, "CIUDAD AUTONOMA DE BUENOS AIRES")
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
        return officialBranchResponsePasoDeLosLibres
      },
      geocodeAddress: async () => null,
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

  // El catálogo se consulta completo (sin filtro de localidad): el matching
  // territorial ocurre server-side, no vía query a Andreani -- ver
  // resolveAndreaniDestinationBranches.
  assert.deepEqual(branchFilters, { canal: "B2C", seHaceAtencionAlCliente: true })
  assert.deepEqual(options, [
    { type: "domicilio", price: 14_000 },
    {
      type: "sucursal",
      price: 13_000,
      // Las sucursales reales ya consultadas para decidir si ofrecer la
      // modalidad ahora se exponen -- antes se descartaban después del
      // chequeo de existencia, dejando al checkout sin ningún dato real
      // para que el cliente eligiera una sucursal concreta. Sin domicilio
      // geocodificable en este caso (mockeado a null), quedan tal cual las
      // trajo Andreani, sin distanciaKm.
      branches: officialBranchResponsePasoDeLosLibres,
    },
  ])
})

test("filtra por localidad+provincia -- descarta una homónima de otra provincia que Andreani pudiera matchear de forma laxa", async () => {
  resetAndreaniCheckoutQuoteStateForTests()
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
      // Andreani devuelve una mezcla: la sucursal real de Corrientes y una
      // homónima de otra provincia -- sólo la primera debe sobrevivir.
      getBranches: async () => [
        ...officialBranchResponsePasoDeLosLibres,
        officialBranchResponse[0],
      ],
      geocodeAddress: async () => null,
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

  const branchOption = options.find((option) => option.type === "sucursal")
  assert.equal(branchOption?.branches?.length, 1)
  assert.equal(branchOption?.branches?.[0].id, 20011)
})

test("Rosario: incluye sucursales con distinto código postal dentro de la misma localidad", async () => {
  resetAndreaniCheckoutQuoteStateForTests()
  const rosarioSanMartin = {
    id: 10044,
    codigo: "ROS",
    numero: "44",
    descripcion: "ROSARIO (AV SAN MARTIN)",
    canal: "B2C",
    direccion: {
      calle: "San Martín",
      numero: "2127",
      provincia: "Santa Fe",
      localidad: "Rosario",
      region: "Litoral",
      pais: "Argentina",
      codigoPostal: "2000",
    },
  }
  const rosarioEvaPeron = {
    id: 10179,
    codigo: "RAC",
    numero: "179",
    descripcion: "ROSARIO (AV EVA PERON)",
    canal: "B2C",
    direccion: {
      calle: "Eva Perón",
      numero: "0",
      provincia: "Santa Fe",
      localidad: "Rosario",
      region: "Litoral",
      pais: "Argentina",
      // CP distinto al de la consulta (2000): debe incluirse igual, ya que
      // el filtro real es por localidad, nunca por CP exacto.
      codigoPostal: "2008",
    },
  }
  let branchFilters: unknown
  const options = await quoteAndreaniCheckout(
    {
      cpDestino: "2000",
      localidad: "Rosario",
      provincia: "Santa Fe",
      items: [{ productId: 10, quantity: 1 }],
    },
    {
      env: { ...qaQuoteEnvironment(), ANDREANI_QA_BRANCH_CONTRACT: "CONTRATO-SUCURSAL-QA" },
      getLocalities: async () => [
        { idDeProvLocalidad: 1, localidad: "ROSARIO", provincia: "SANTA FE", codigosPostales: ["2000"] },
      ],
      getBranches: async (filters) => {
        branchFilters = filters
        return [rosarioSanMartin, rosarioEvaPeron]
      },
      geocodeAddress: async () => null,
      loadItems: async () => [
        { product: completeProduct, variant: null, quantity: 1, discountPercent: 0 },
      ],
      quoteTariff: async (input) => ({
        pesoAforado: "1",
        tarifaSinIva: { seguroDistribucion: "0", distribucion: "13400", total: "13400" },
        tarifaConIva: {
          seguroDistribucion: "0",
          distribucion: "13500",
          total: input.contrato === "CONTRATO-SUCURSAL-QA" ? "13100" : "13500",
        },
      }),
    },
  )

  assert.deepEqual(branchFilters, { canal: "B2C", seHaceAtencionAlCliente: true })
  const branchOption = options.find((option) => option.type === "sucursal")
  assert.equal(branchOption?.branches?.length, 2)
  assert.deepEqual(
    branchOption?.branches?.map((b) => b.direccion.codigoPostal).sort(),
    ["2000", "2008"],
  )
})

test("CABA: consulta a Andreani con la etiqueta real C.A.B.A. y acepta sus sucursales aunque Andreani las taggee con provincia Buenos Aires", async () => {
  resetAndreaniCheckoutQuoteStateForTests()
  // Confirmado en vivo contra Andreani QA: las sucursales de CABA comparten
  // `direccion.localidad = "C.a.b.a."` y quedan taggeadas con
  // `direccion.provincia = "Buenos Aires"` (nunca "CABA"/"Capital Federal").
  // El catálogo mockeado mezcla esa sucursal con otras de provincias
  // distintas para probar que el matching las separa sin depender de ningún
  // query de localidad hacia Andreani (ya no se envía ninguno).
  const cabaBranch = {
    id: 10010,
    codigo: "PAL",
    numero: "10",
    descripcion: "PALERMO (AV SCALABRINI ORTIZ)",
    canal: "B2C",
    direccion: {
      calle: "Av Scalabrini Ortiz",
      numero: "1000",
      provincia: "Buenos Aires",
      localidad: "C.a.b.a.",
      region: "Caba",
      pais: "Argentina",
      codigoPostal: "1414",
    },
  }
  let branchFilters: unknown
  const options = await quoteAndreaniCheckout(
    {
      cpDestino: "1424",
      localidad: "Ciudad Autónoma de Buenos Aires",
      provincia: "CABA",
      items: [{ productId: 10, quantity: 1 }],
    },
    {
      env: { ...qaQuoteEnvironment(), ANDREANI_QA_BRANCH_CONTRACT: "CONTRATO-SUCURSAL-QA" },
      getLocalities: async () => [
        {
          idDeProvLocalidad: 1,
          localidad: "CIUDAD AUTONOMA DE BUENOS AIRES",
          provincia: "CAPITAL FEDERAL",
          codigosPostales: ["1424"],
        },
      ],
      getBranches: async (filters) => {
        branchFilters = filters
        return [cabaBranch, ...officialBranchResponse, ...officialBranchResponsePasoDeLosLibres]
      },
      geocodeAddress: async () => null,
      loadItems: async () => [
        { product: completeProduct, variant: null, quantity: 1, discountPercent: 0 },
      ],
      quoteTariff: async (input) => ({
        pesoAforado: "1",
        tarifaSinIva: { seguroDistribucion: "0", distribucion: "13400", total: "13400" },
        tarifaConIva: {
          seguroDistribucion: "0",
          distribucion: "13500",
          total: input.contrato === "CONTRATO-SUCURSAL-QA" ? "13100" : "13500",
        },
      }),
    },
  )

  // Catálogo nacional: se pide una sola vez, sin filtro de localidad.
  assert.deepEqual(branchFilters, { canal: "B2C", seHaceAtencionAlCliente: true })
  const branchOption = options.find((option) => option.type === "sucursal")
  assert.equal(branchOption?.branches?.length, 1)
  assert.equal(branchOption?.branches?.[0].id, 10010)
})

test("CABA: una sucursal real de la provincia de Buenos Aires (localidad distinta, ej. La Plata) no se cuela", async () => {
  resetAndreaniCheckoutQuoteStateForTests()
  const cabaBranch = {
    id: 10010,
    codigo: "PAL",
    numero: "10",
    descripcion: "PALERMO (AV SCALABRINI ORTIZ)",
    canal: "B2C",
    direccion: {
      calle: "Av Scalabrini Ortiz",
      numero: "1000",
      provincia: "Buenos Aires",
      localidad: "C.a.b.a.",
      region: "Caba",
      pais: "Argentina",
      codigoPostal: "1414",
    },
  }
  const laPlataBranch = {
    id: 10006,
    codigo: "LPL",
    numero: "6",
    descripcion: "LA PLATA (AV 13)",
    canal: "B2C",
    direccion: {
      calle: "Av 13",
      numero: "500",
      provincia: "Buenos Aires",
      localidad: "La Plata",
      region: "GBA",
      pais: "Argentina",
      codigoPostal: "1900",
    },
  }
  const options = await quoteAndreaniCheckout(
    {
      cpDestino: "1424",
      localidad: "CABA",
      provincia: "CABA",
      items: [{ productId: 10, quantity: 1 }],
    },
    {
      env: { ...qaQuoteEnvironment(), ANDREANI_QA_BRANCH_CONTRACT: "CONTRATO-SUCURSAL-QA" },
      getLocalities: async () => [
        {
          idDeProvLocalidad: 1,
          localidad: "CABA",
          provincia: "CAPITAL FEDERAL",
          codigosPostales: ["1424"],
        },
      ],
      // Andreani devuelve ambas para el filtro localidad=C.A.B.A. -- sólo la
      // que realmente pertenece a CABA debe sobrevivir.
      getBranches: async () => [cabaBranch, laPlataBranch],
      geocodeAddress: async () => null,
      loadItems: async () => [
        { product: completeProduct, variant: null, quantity: 1, discountPercent: 0 },
      ],
      quoteTariff: async (input) => ({
        pesoAforado: "1",
        tarifaSinIva: { seguroDistribucion: "0", distribucion: "13400", total: "13400" },
        tarifaConIva: {
          seguroDistribucion: "0",
          distribucion: "13500",
          total: input.contrato === "CONTRATO-SUCURSAL-QA" ? "13100" : "13500",
        },
      }),
    },
  )

  const branchOption = options.find((option) => option.type === "sucursal")
  assert.equal(branchOption?.branches?.length, 1)
  assert.equal(branchOption?.branches?.[0].id, 10010)
})

test("homónimos reales: misma localidad en dos provincias no se mezclan (San Martín, Mendoza vs Buenos Aires)", async () => {
  resetAndreaniCheckoutQuoteStateForTests()
  const sanMartinMendoza = {
    id: 30001,
    codigo: "SMM",
    numero: "1",
    descripcion: "SAN MARTIN MENDOZA",
    canal: "B2C",
    direccion: {
      calle: "San Martín",
      numero: "100",
      provincia: "Mendoza",
      localidad: "San Martin",
      region: "Cuyo",
      pais: "Argentina",
      codigoPostal: "5570",
    },
  }
  const sanMartinBuenosAires = {
    id: 30002,
    codigo: "SMB",
    numero: "2",
    descripcion: "SAN MARTIN BUENOS AIRES",
    canal: "B2C",
    direccion: {
      calle: "San Martín",
      numero: "200",
      provincia: "Buenos Aires",
      localidad: "San Martin",
      region: "GBA",
      pais: "Argentina",
      codigoPostal: "1650",
    },
  }
  const options = await quoteAndreaniCheckout(
    {
      cpDestino: "5570",
      localidad: "San Martín",
      provincia: "Mendoza",
      items: [{ productId: 10, quantity: 1 }],
    },
    {
      env: { ...qaQuoteEnvironment(), ANDREANI_QA_BRANCH_CONTRACT: "CONTRATO-SUCURSAL-QA" },
      getLocalities: async () => [
        { idDeProvLocalidad: 1, localidad: "SAN MARTIN", provincia: "MENDOZA", codigosPostales: ["5570"] },
      ],
      getBranches: async () => [sanMartinMendoza, sanMartinBuenosAires],
      geocodeAddress: async () => null,
      loadItems: async () => [
        { product: completeProduct, variant: null, quantity: 1, discountPercent: 0 },
      ],
      quoteTariff: async (input) => ({
        pesoAforado: "1",
        tarifaSinIva: { seguroDistribucion: "0", distribucion: "13400", total: "13400" },
        tarifaConIva: {
          seguroDistribucion: "0",
          distribucion: "13500",
          total: input.contrato === "CONTRATO-SUCURSAL-QA" ? "13100" : "13500",
        },
      }),
    },
  )

  const branchOption = options.find((option) => option.type === "sucursal")
  assert.equal(branchOption?.branches?.length, 1)
  assert.equal(branchOption?.branches?.[0].id, 30001)
})

test("San Juan: una sucursal taggeada con el partido vecino (Santa Lucía) se encuentra igual vía código postal atendido", async () => {
  resetAndreaniCheckoutQuoteStateForTests()
  // Confirmado en vivo contra Andreani QA: la única sucursal de la ciudad de
  // San Juan está taggeada con `direccion.localidad = "Santa Lucia"` (un
  // partido vecino, no "San Juan"), así que el match por nombre de
  // localidad nunca la encuentra. Sí declara "5400" -- el CP real de San
  // Juan Capital -- entre sus `codigosPostalesAtendidos`, que es la señal
  // que debe rescatarla.
  const sanJuanBranch = {
    id: 10038,
    codigo: "UAQ",
    numero: "38",
    descripcion: "SAN JUAN (AV 25 DE MAYO ESTE)",
    canal: "B2C",
    direccion: {
      calle: "25 de Mayo Este",
      numero: "1303",
      provincia: "San Juan",
      localidad: "Santa Lucia",
      region: "Cuyo",
      pais: "Argentina",
      codigoPostal: "5411",
    },
    codigosPostalesAtendidos: ["5400", "5401", "5411", "5412"],
  }
  const options = await quoteAndreaniCheckout(
    {
      cpDestino: "5400",
      localidad: "San Juan",
      provincia: "San Juan",
      items: [{ productId: 10, quantity: 1 }],
    },
    {
      env: { ...qaQuoteEnvironment(), ANDREANI_QA_BRANCH_CONTRACT: "CONTRATO-SUCURSAL-QA" },
      getLocalities: async () => [
        { idDeProvLocalidad: 1, localidad: "SAN JUAN", provincia: "SAN JUAN", codigosPostales: ["5400"] },
      ],
      // Catálogo nacional mockeado: mezcla la sucursal de San Juan con otras
      // de provincias distintas, para probar que el matching no depende de
      // que el mock devuelva sólo lo relevante.
      getBranches: async () => [sanJuanBranch, ...officialBranchResponse],
      geocodeAddress: async () => null,
      loadItems: async () => [
        { product: completeProduct, variant: null, quantity: 1, discountPercent: 0 },
      ],
      quoteTariff: async (input) => ({
        pesoAforado: "1",
        tarifaSinIva: { seguroDistribucion: "0", distribucion: "13400", total: "13400" },
        tarifaConIva: {
          seguroDistribucion: "0",
          distribucion: "13500",
          total: input.contrato === "CONTRATO-SUCURSAL-QA" ? "13100" : "13500",
        },
      }),
    },
  )

  const branchOption = options.find((option) => option.type === "sucursal")
  assert.equal(branchOption?.branches?.length, 1)
  assert.equal(branchOption?.branches?.[0].id, 10038)
})

test("San Juan: el código postal atendido no rescata sucursales de otra provincia (la provincia nunca se relaja)", async () => {
  resetAndreaniCheckoutQuoteStateForTests()
  // Misma sucursal que el test anterior, pero ahora el destino pedido es de
  // otra provincia -- aunque coincidiera el CP declarado, nunca debe
  // aparecer una sucursal de San Juan para un destino de Corrientes.
  const sanJuanBranch = {
    id: 10038,
    codigo: "UAQ",
    numero: "38",
    descripcion: "SAN JUAN (AV 25 DE MAYO ESTE)",
    canal: "B2C",
    direccion: {
      calle: "25 de Mayo Este",
      numero: "1303",
      provincia: "San Juan",
      localidad: "Santa Lucia",
      region: "Cuyo",
      pais: "Argentina",
      codigoPostal: "5411",
    },
    codigosPostalesAtendidos: ["3230"],
  }
  const options = await quoteAndreaniCheckout(
    {
      cpDestino: "3230",
      localidad: "Paso de los Libres",
      provincia: "Corrientes",
      items: [{ productId: 10, quantity: 1 }],
    },
    {
      env: { ...qaQuoteEnvironment(), ANDREANI_QA_BRANCH_CONTRACT: "CONTRATO-SUCURSAL-QA" },
      getLocalities: async () => officialLocalityResponse,
      getBranches: async () => [sanJuanBranch, ...officialBranchResponsePasoDeLosLibres],
      geocodeAddress: async () => null,
      loadItems: async () => [
        { product: completeProduct, variant: null, quantity: 1, discountPercent: 0 },
      ],
      quoteTariff: async (input) => ({
        pesoAforado: "1",
        tarifaSinIva: { seguroDistribucion: "0", distribucion: "13400", total: "13400" },
        tarifaConIva: {
          seguroDistribucion: "0",
          distribucion: "13500",
          total: input.contrato === "CONTRATO-SUCURSAL-QA" ? "13100" : "13500",
        },
      }),
    },
  )

  const branchOption = options.find((option) => option.type === "sucursal")
  assert.equal(branchOption?.branches?.length, 1)
  assert.equal(branchOption?.branches?.[0].id, 20011)
})

test("resolveVerifiedAndreaniBranch: San Juan usa exactamente el mismo criterio (nombre o CP atendido) que el discovery", async () => {
  resetAndreaniCheckoutQuoteStateForTests()
  const sanJuanBranch = {
    id: 10038,
    codigo: "UAQ",
    numero: "38",
    descripcion: "SAN JUAN (AV 25 DE MAYO ESTE)",
    canal: "B2C",
    direccion: {
      calle: "25 de Mayo Este",
      numero: "1303",
      provincia: "San Juan",
      localidad: "Santa Lucia",
      region: "Cuyo",
      pais: "Argentina",
      codigoPostal: "5411",
    },
    codigosPostalesAtendidos: ["5400", "5401", "5411", "5412"],
  }
  const branch = await resolveVerifiedAndreaniBranch(
    { localidad: "San Juan", provincia: "San Juan", cpDestino: "5400" },
    10038,
    {
      env: { ...qaQuoteEnvironment(), ANDREANI_QA_BRANCH_CONTRACT: "CONTRATO-SUCURSAL-QA" },
      getBranches: async () => [sanJuanBranch],
    },
  )

  assert.equal(branch.id, "10038")
  assert.equal(branch.localidad, "Santa Lucia")
})

test("sucursal sin coordenadas sigue apareciendo en la lista (sin distanciaKm, no se descarta)", async () => {
  resetAndreaniCheckoutQuoteStateForTests()
  const sinCoordenadas = {
    id: 40001,
    codigo: "SNC",
    numero: "1",
    descripcion: "SUCURSAL SIN COORDENADAS",
    canal: "B2C",
    direccion: {
      calle: "Colón",
      numero: "850",
      provincia: "CORRIENTES",
      localidad: "PASO DE LOS LIBRES",
      region: "Litoral",
      pais: "Argentina",
      codigoPostal: "3230",
    },
    // Sin `coordenadas`: Andreani no siempre las informa.
  }
  const options = await quoteAndreaniCheckout(
    {
      cpDestino: "3230",
      localidad: "PASO DE LOS LIBRES",
      provincia: "CORRIENTES",
      calle: "Colón",
      numero: "800",
      items: [{ productId: 10, quantity: 1 }],
    },
    {
      env: { ...qaQuoteEnvironment(), ANDREANI_QA_BRANCH_CONTRACT: "CONTRATO-SUCURSAL-QA" },
      getLocalities: async () => officialLocalityResponse,
      getBranches: async () => [sinCoordenadas],
      geocodeAddress: async () => ({ lat: -29.7, lng: -57.09 }),
      loadItems: async () => [
        { product: completeProduct, variant: null, quantity: 1, discountPercent: 0 },
      ],
      quoteTariff: async (input) => ({
        pesoAforado: "1",
        tarifaSinIva: { seguroDistribucion: "0", distribucion: "13400", total: "13400" },
        tarifaConIva: {
          seguroDistribucion: "0",
          distribucion: "13500",
          total: input.contrato === "CONTRATO-SUCURSAL-QA" ? "13100" : "13500",
        },
      }),
    },
  )

  const branchOption = options.find((option) => option.type === "sucursal")
  assert.equal(branchOption?.branches?.length, 1)
  assert.equal(branchOption?.branches?.[0].id, 40001)
  assert.equal(branchOption?.branches?.[0].distanciaKm, undefined)
})

test("cuando se puede geocodificar el domicilio, las sucursales se devuelven ordenadas por cercanía real con distanciaKm", async () => {
  resetAndreaniCheckoutQuoteStateForTests()
  const lejana = {
    id: 10229,
    codigo: "PRC",
    numero: "29",
    descripcion: "ROSARIO (CIRCUNVALACION)",
    canal: "B2C",
    direccion: {
      calle: "José María Rosa",
      numero: "8051",
      provincia: "SANTA FE",
      localidad: "ROSARIO",
      region: "Litoral",
      pais: "Argentina",
      codigoPostal: "2000",
    },
    coordenadas: { latitud: "-33.015652", longitud: "-60.667958" },
  }
  const cercana = {
    id: 10044,
    codigo: "ROS",
    numero: "44",
    descripcion: "ROSARIO (AV SAN MARTIN)",
    canal: "B2C",
    direccion: {
      calle: "San Martín",
      numero: "2127",
      provincia: "SANTA FE",
      localidad: "ROSARIO",
      region: "Litoral",
      pais: "Argentina",
      codigoPostal: "2000",
    },
    coordenadas: { latitud: "-32.962580", longitud: "-60.640600" },
  }
  let geocodedInput: unknown
  const options = await quoteAndreaniCheckout(
    {
      cpDestino: "2000",
      localidad: "ROSARIO",
      provincia: "SANTA FE",
      calle: "San Martín",
      numero: "2100",
      items: [{ productId: 10, quantity: 1 }],
    },
    {
      env: {
        ...qaQuoteEnvironment(),
        ANDREANI_QA_BRANCH_CONTRACT: "CONTRATO-SUCURSAL-QA",
      },
      getLocalities: async () => [
        {
          idDeProvLocalidad: 1,
          localidad: "ROSARIO",
          provincia: "SANTA FE",
          codigosPostales: ["2000"],
        },
      ],
      getBranches: async () => [lejana, cercana],
      geocodeAddress: async (input) => {
        geocodedInput = input
        // Coordenadas reales muy cerca de "cercana", lejos de "lejana".
        return { lat: -32.9626, lng: -60.6407 }
      },
      loadItems: async () => [
        { product: completeProduct, variant: null, quantity: 1, discountPercent: 0 },
      ],
      quoteTariff: async (input) => ({
        pesoAforado: "1",
        tarifaSinIva: { seguroDistribucion: "0", distribucion: "13400", total: "13400" },
        tarifaConIva: {
          seguroDistribucion: "0",
          distribucion: "13500",
          total: input.contrato === "CONTRATO-SUCURSAL-QA" ? "13100" : "13500",
        },
      }),
    },
  )

  assert.deepEqual(geocodedInput, {
    calle: "San Martín",
    numero: "2100",
    localidad: "ROSARIO",
    provincia: "SANTA FE",
    codigoPostal: "2000",
  })
  const branchOption = options.find((option) => option.type === "sucursal")
  assert.equal(branchOption?.branches?.[0].id, 10044)
  assert.equal(branchOption?.branches?.[1].id, 10229)
  assert.ok(typeof branchOption?.branches?.[0].distanciaKm === "number")
  assert.ok(branchOption!.branches![0].distanciaKm! < branchOption!.branches![1].distanciaKm!)
})

const santaFeDestination = { localidad: "Santa Fe", provincia: "Santa Fe", cpDestino: "3000" }

test("resolveVerifiedAndreaniBranch: id real elegido por el cliente -> snapshot canónico persistible", async () => {
  resetAndreaniCheckoutQuoteStateForTests()
  const branch = await resolveVerifiedAndreaniBranch(santaFeDestination, 10055, {
    env: {
      ...qaQuoteEnvironment(),
      ANDREANI_QA_BRANCH_CONTRACT: "CONTRATO-SUCURSAL-QA",
    },
    getBranches: async () => officialBranchResponse,
  })

  assert.deepEqual(branch, {
    id: "10055",
    codigo: "SFN",
    nombre: "SANTA FE (CENTRO)",
    direccion: "25 de Mayo 3340",
    localidad: "Santa Fe",
    provincia: "Santa Fe",
    codigoPostal: "3000",
  })
})

test("resolveVerifiedAndreaniBranch: un id inventado/manipulado (no está en la lista real) se rechaza", async () => {
  resetAndreaniCheckoutQuoteStateForTests()
  await assert.rejects(
    () =>
      resolveVerifiedAndreaniBranch(santaFeDestination, 99999, {
        env: {
          ...qaQuoteEnvironment(),
          ANDREANI_QA_BRANCH_CONTRACT: "CONTRATO-SUCURSAL-QA",
        },
        getBranches: async () => officialBranchResponse,
      }),
    (error: unknown) =>
      error instanceof AndreaniError && error.code === "VALIDATION_ERROR",
  )
})

test("resolveVerifiedAndreaniBranch: una sucursal real pero de otra localidad/provincia (mismo id, destino distinto) se rechaza", async () => {
  resetAndreaniCheckoutQuoteStateForTests()
  // officialBranchResponsePasoDeLosLibres.id=20011 es una sucursal real, pero
  // de Corrientes -- pedirla para un destino en Santa Fe debe rechazarse
  // igual que un id inventado.
  await assert.rejects(
    () =>
      resolveVerifiedAndreaniBranch(santaFeDestination, 20011, {
        env: {
          ...qaQuoteEnvironment(),
          ANDREANI_QA_BRANCH_CONTRACT: "CONTRATO-SUCURSAL-QA",
        },
        getBranches: async () => [
          ...officialBranchResponse,
          ...officialBranchResponsePasoDeLosLibres,
        ],
      }),
    (error: unknown) =>
      error instanceof AndreaniError && error.code === "VALIDATION_ERROR",
  )
})

test("resolveVerifiedAndreaniBranch: nunca confía en nombre/dirección mandados por el cliente -- sólo usa lo que devuelve Andreani", async () => {
  resetAndreaniCheckoutQuoteStateForTests()
  // El propio tipo de entrada no acepta nombre/dirección -- esta prueba
  // documenta esa garantía: pase lo que pase en el "id", el resultado sale
  // siempre de officialBranchResponse.
  const branch = await resolveVerifiedAndreaniBranch(santaFeDestination, "10055", {
    env: {
      ...qaQuoteEnvironment(),
      ANDREANI_QA_BRANCH_CONTRACT: "CONTRATO-SUCURSAL-QA",
    },
    getBranches: async () => officialBranchResponse,
  })

  assert.equal(branch.nombre, "SANTA FE (CENTRO)")
  assert.equal(branch.direccion, "25 de Mayo 3340")
})

test("resolveVerifiedAndreaniBranch: usa el mismo criterio territorial que el discovery para CABA", async () => {
  // Misma sucursal/destino que el test de discovery de CABA: si acá se
  // usara un criterio distinto (por ejemplo, exigiendo provincia === "CABA"
  // en vez de aceptar "Buenos Aires" como Andreani la tagguea), el checkout
  // podría dejar elegir una sucursal que el servidor luego rechaza al crear
  // la orden.
  resetAndreaniCheckoutQuoteStateForTests()
  const cabaBranch = {
    id: 10010,
    codigo: "PAL",
    numero: "10",
    descripcion: "PALERMO (AV SCALABRINI ORTIZ)",
    canal: "B2C",
    direccion: {
      calle: "Av Scalabrini Ortiz",
      numero: "1000",
      provincia: "Buenos Aires",
      localidad: "C.a.b.a.",
      region: "Caba",
      pais: "Argentina",
      codigoPostal: "1414",
    },
  }
  const branch = await resolveVerifiedAndreaniBranch(
    { localidad: "Ciudad Autónoma de Buenos Aires", provincia: "CABA", cpDestino: "1424" },
    10010,
    {
      env: { ...qaQuoteEnvironment(), ANDREANI_QA_BRANCH_CONTRACT: "CONTRATO-SUCURSAL-QA" },
      getBranches: async () => [cabaBranch],
    },
  )

  assert.equal(branch.id, "10010")
  assert.equal(branch.localidad, "C.a.b.a.")
  assert.equal(branch.provincia, "Buenos Aires")
})

test("resolveVerifiedAndreaniBranch: una sucursal real de Buenos Aires (La Plata) no se acepta para un destino CABA", async () => {
  resetAndreaniCheckoutQuoteStateForTests()
  const laPlataBranch = {
    id: 10006,
    codigo: "LPL",
    numero: "6",
    descripcion: "LA PLATA (AV 13)",
    canal: "B2C",
    direccion: {
      calle: "Av 13",
      numero: "500",
      provincia: "Buenos Aires",
      localidad: "La Plata",
      region: "GBA",
      pais: "Argentina",
      codigoPostal: "1900",
    },
  }
  await assert.rejects(
    () =>
      resolveVerifiedAndreaniBranch(
        { localidad: "CABA", provincia: "CABA", cpDestino: "1424" },
        10006,
        {
          env: { ...qaQuoteEnvironment(), ANDREANI_QA_BRANCH_CONTRACT: "CONTRATO-SUCURSAL-QA" },
          getBranches: async () => [laPlataBranch],
        },
      ),
    (error: unknown) => error instanceof AndreaniError && error.code === "VALIDATION_ERROR",
  )
})

test("resolveVerifiedAndreaniBranch: sin contrato de sucursal configurado, rechaza sin consultar sucursales", async () => {
  resetAndreaniCheckoutQuoteStateForTests()
  let called = false

  await assert.rejects(
    () =>
      resolveVerifiedAndreaniBranch(santaFeDestination, 10055, {
        env: qaQuoteEnvironment(),
        getBranches: async () => {
          called = true
          return officialBranchResponse
        },
      }),
    (error: unknown) =>
      error instanceof AndreaniError && error.code === "VALIDATION_ERROR",
  )
  assert.equal(called, false)
})

test("resolveVerifiedAndreaniBranch: localidad/provincia o id inválidos se rechazan sin llamar a Andreani", async () => {
  const env = {
    ...qaQuoteEnvironment(),
    ANDREANI_QA_BRANCH_CONTRACT: "CONTRATO-SUCURSAL-QA",
  }

  for (const [destination, id] of [
    [{ localidad: "", provincia: "Santa Fe", cpDestino: "3000" }, 10055],
    [{ localidad: "Santa Fe", provincia: "", cpDestino: "3000" }, 10055],
    [{ localidad: "Santa Fe", provincia: "Santa Fe", cpDestino: "" }, 10055],
    [{ localidad: "Santa Fe", provincia: "Santa Fe", cpDestino: "ABCD" }, 10055],
    [{ localidad: "Santa Fe", provincia: "Santa Fe", cpDestino: "300" }, 10055],
    [santaFeDestination, 0],
    [santaFeDestination, -1],
    [santaFeDestination, "no-numero"],
  ] as const) {
    let called = false
    await assert.rejects(
      () =>
        resolveVerifiedAndreaniBranch(destination, id, {
          env,
          getBranches: async () => {
            called = true
            return officialBranchResponse
          },
        }),
      (error: unknown) =>
        error instanceof AndreaniError && error.code === "VALIDATION_ERROR",
    )
    assert.equal(called, false)
  }
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
