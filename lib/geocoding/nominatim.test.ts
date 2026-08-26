import assert from "node:assert/strict"
import test from "node:test"

import {
  geocodeCustomerAddress,
  resetNominatimGeocodeCacheForTests,
} from "./nominatim.ts"

function fakeFetch(
  responder: (url: string) => { ok: boolean; body?: unknown },
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input)
    const { ok, body } = responder(url)
    return {
      ok,
      json: async () => body ?? [],
    } as Response
  }) as typeof fetch
}

test("geocodeCustomerAddress: nunca llama a la red sin localidad/provincia -- devuelve null directamente", async () => {
  let called = false
  const point = await geocodeCustomerAddress(
    { localidad: "", provincia: "" },
    { fetchImpl: (async () => { called = true; return { ok: true, json: async () => [] } as Response }) },
  )
  assert.equal(point, null)
  assert.equal(called, false)
})

test("geocodeCustomerAddress: dirección completa resuelta -> coordenadas reales de la respuesta, nunca inventadas", async () => {
  resetNominatimGeocodeCacheForTests()
  const point = await geocodeCustomerAddress(
    { calle: "San Martín", numero: "2127", localidad: "Rosario", provincia: "Santa Fe", codigoPostal: "2000" },
    {
      fetchImpl: fakeFetch(() => ({
        ok: true,
        body: [{ lat: "-32.9468", lon: "-60.6393" }],
      })),
    },
  )
  assert.deepEqual(point, { lat: -32.9468, lng: -60.6393 })
})

test("geocodeCustomerAddress: sin resultado para la dirección exacta, degrada a localidad+provincia en vez de fallar", async () => {
  resetNominatimGeocodeCacheForTests()
  let calls = 0
  const point = await geocodeCustomerAddress(
    { calle: "Calle Inexistente", numero: "99999", localidad: "Rosario", provincia: "Santa Fe" },
    {
      fetchImpl: fakeFetch((url) => {
        calls++
        if (url.includes("Calle+Inexistente") || url.includes("Calle%20Inexistente")) {
          return { ok: true, body: [] }
        }
        return { ok: true, body: [{ lat: "-32.95", lon: "-60.65" }] }
      }),
    },
  )
  assert.deepEqual(point, { lat: -32.95, lng: -60.65 })
  assert.equal(calls, 2)
})

test("geocodeCustomerAddress: error de red o timeout nunca se propaga -- se trata como sin resultado", async () => {
  resetNominatimGeocodeCacheForTests()
  const point = await geocodeCustomerAddress(
    { localidad: "Rosario", provincia: "Santa Fe" },
    { fetchImpl: (async () => { throw new Error("network down") }) },
  )
  assert.equal(point, null)
})

test("geocodeCustomerAddress: respuesta sin lat/lon numéricos se trata como sin resultado", async () => {
  resetNominatimGeocodeCacheForTests()
  const point = await geocodeCustomerAddress(
    { localidad: "Rosario", provincia: "Santa Fe" },
    { fetchImpl: fakeFetch(() => ({ ok: true, body: [{ lat: "no-numero", lon: "-60.65" }] })) },
  )
  assert.equal(point, null)
})

test("geocodeCustomerAddress: la misma dirección normalizada se cachea -- no repite la llamada", async () => {
  resetNominatimGeocodeCacheForTests()
  let calls = 0
  const dependencies = {
    fetchImpl: fakeFetch(() => {
      calls++
      return { ok: true, body: [{ lat: "-32.9468", lon: "-60.6393" }] }
    }),
  }
  const input = { calle: "San Martín", numero: "2127", localidad: "Rosario", provincia: "Santa Fe", codigoPostal: "2000" }

  await geocodeCustomerAddress(input, dependencies)
  await geocodeCustomerAddress(input, dependencies)

  assert.equal(calls, 1)
})

test("geocodeCustomerAddress: dos requests concurrentes de la misma dirección comparten una sola llamada en vuelo", async () => {
  resetNominatimGeocodeCacheForTests()
  let calls = 0
  const dependencies = {
    fetchImpl: fakeFetch(() => {
      calls++
      return { ok: true, body: [{ lat: "-32.9468", lon: "-60.6393" }] }
    }),
  }
  const input = { calle: "Urquiza", numero: "500", localidad: "Rosario", provincia: "Santa Fe" }

  const [a, b] = await Promise.all([
    geocodeCustomerAddress(input, dependencies),
    geocodeCustomerAddress(input, dependencies),
  ])

  assert.deepEqual(a, b)
  assert.equal(calls, 1)
})
