import assert from "node:assert/strict"
import test from "node:test"

import { AndreaniError } from "./client.ts"
import {
  aggregateAndreaniPackage,
  matchAndreaniCheckoutLocality,
  normalizeCheckoutQuoteRequest,
  quoteAndreaniCheckout,
  resetAndreaniCheckoutQuoteStateForTests,
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
  }
}

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

test("la cotización usa el paquete agregado y el endpoint central", async () => {
  resetAndreaniCheckoutQuoteStateForTests()
  let receivedWeight = 0
  let receivedVolume = 0
  const loadedItems: LoadedCheckoutQuoteItem[] = [
    { product: completeProduct, variant: null, quantity: 2, discountPercent: 0 },
  ]

  const options = await quoteAndreaniCheckout(
    {
      cpDestino: "3230",
      localidad: "Paso de los Libres",
      provincia: "Corrientes",
      items: [{ productId: 10, quantity: 2 }],
    },
    {
      env: qaQuoteEnvironment(),
      getLocalities: async (filters) => {
        assert.deepEqual(filters, { codigosPostales: "3230" })
        return officialLocalityResponse
      },
      loadItems: async () => loadedItems,
      quoteTariff: async (input) => {
        receivedWeight = input.bultos[0].kilos ?? 0
        receivedVolume = input.bultos[0].volumen
        assert.equal(input.cpDestino, "3230")
        assert.equal(input.contrato, "CONTRATO-QA")
        return {
          pesoAforado: "2",
          tarifaSinIva: { seguroDistribucion: "0", distribucion: "100", total: "100" },
          tarifaConIva: { seguroDistribucion: "0", distribucion: "121", total: "121" },
        }
      },
    },
  )

  assert.equal(receivedWeight, 2)
  assert.equal(receivedVolume, 12_000)
  assert.deepEqual(options, [{ type: "domicilio", price: 121 }])
})

test("valida localidad y provincia ignorando diferencias de mayúsculas", () => {
  const locality = matchAndreaniCheckoutLocality(
    {
      cpDestino: "3230",
      localidad: "Paso de los Libres",
      provincia: "Corrientes",
    },
    officialLocalityResponse,
  )

  assert.equal(locality.localidad, "PASO DE LOS LIBRES")
  assert.equal(locality.provincia, "CORRIENTES")
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
          distribucion: "100",
          total: "100",
        },
        tarifaConIva: {
          seguroDistribucion: "0",
          distribucion: "121",
          total:
            input.contrato === "CONTRATO-SUCURSAL-QA" ? "110" : "121",
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
    { type: "domicilio", price: 121 },
    { type: "sucursal", price: 110 },
  ])
})

test("no accede al carrito si la localidad no coincide con el código postal", async () => {
  resetAndreaniCheckoutQuoteStateForTests()
  let itemsWereLoaded = false

  await assert.rejects(
    () =>
      quoteAndreaniCheckout(
        {
          cpDestino: "3230",
          localidad: "PASO DE LOS LIBRES",
          provincia: "SANTA FE",
          items: [{ productId: 10, quantity: 1 }],
        },
        {
          env: qaQuoteEnvironment(),
          getLocalities: async () => officialLocalityResponse,
          loadItems: async () => {
            itemsWereLoaded = true
            return []
          },
        },
      ),
    (error) =>
      error instanceof AndreaniError && error.code === "VALIDATION_ERROR",
  )
  assert.equal(itemsWereLoaded, false)
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
