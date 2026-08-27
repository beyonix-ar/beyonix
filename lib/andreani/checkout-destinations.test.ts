import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  getCheckoutPostalCodes,
  getCheckoutProvinceLocalities,
  isCheckoutDestinationCached,
  resetCheckoutDestinationStateForTests,
} from "./checkout-destinations.ts"
import { AndreaniError } from "./client.ts"
import type { AndreaniLocality } from "./types.ts"

function georefResponse(names: string[]) {
  return {
    asentamientos: names.map((nombre, index) => ({
      id: String(index + 1).padStart(8, "0"),
      nombre,
    })),
  }
}

function fakeGeorefFetch(body: unknown) {
  return async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
}

test("Georef: CABA siempre colapsa a una única localidad, sin importar los barrios reales", async () => {
  resetCheckoutDestinationStateForTests()

  const localities = await getCheckoutProvinceLocalities("CABA", {
    fetch: fakeGeorefFetch(georefResponse(["RECOLETA", "CABALLITO", "PALERMO"])),
  })

  assert.equal(localities.length, 1)
  assert.equal(localities[0].name, "CIUDAD AUTÓNOMA DE BUENOS AIRES")
})

test("Georef: Santa Fe conserva las localidades reales, incluida Rosario", async () => {
  resetCheckoutDestinationStateForTests()

  const localities = await getCheckoutProvinceLocalities("Santa Fe", {
    fetch: fakeGeorefFetch(georefResponse(["ROSARIO", "SANTA FE", "LA ROSARIO"])),
  })

  const names = localities.map((l) => l.name)
  assert.ok(names.includes("ROSARIO"))
  assert.ok(names.includes("LA ROSARIO"))
  assert.notEqual(
    names.indexOf("ROSARIO"),
    names.indexOf("LA ROSARIO"),
    "Rosario y La Rosario deben quedar como localidades separadas, no colapsarse",
  )
})

test("Andreani: los códigos postales de una localidad se filtran por la provincia pedida (homónimos)", async () => {
  resetCheckoutDestinationStateForTests()

  const andreaniLocalities: AndreaniLocality[] = [
    { idDeProvLocalidad: 1, localidad: "SAN MARTIN", provincia: "MENDOZA", codigosPostales: ["5570"] },
    { idDeProvLocalidad: 2, localidad: "SAN MARTIN", provincia: "BUENOS AIRES", codigosPostales: ["1650", "1654"] },
  ]

  const mendoza = await getCheckoutPostalCodes("Mendoza", "San Martín", {
    fetch: fakeGeorefFetch(georefResponse(["SAN MARTÍN"])),
    getAndreaniLocalities: async () => andreaniLocalities,
  })
  assert.deepEqual(mendoza.postalCodes, ["5570"])

  resetCheckoutDestinationStateForTests()
  const buenosAires = await getCheckoutPostalCodes("Buenos Aires", "San Martín", {
    fetch: fakeGeorefFetch(georefResponse(["SAN MARTÍN"])),
    getAndreaniLocalities: async () => andreaniLocalities,
  })
  assert.deepEqual(buenosAires.postalCodes, ["1650", "1654"])
})

test("Andreani: la localidad se resuelve igual con o sin tilde (Córdoba)", async () => {
  resetCheckoutDestinationStateForTests()

  const result = await getCheckoutPostalCodes("Cordoba", "Cordoba", {
    fetch: fakeGeorefFetch(georefResponse(["CÓRDOBA"])),
    getAndreaniLocalities: async () => [
      { idDeProvLocalidad: 1, localidad: "CORDOBA", provincia: "CORDOBA", codigosPostales: ["5000", "5001"] },
    ],
  })

  assert.equal(result.locality, "CÓRDOBA")
  assert.deepEqual(result.postalCodes, ["5000", "5001"])
})

test("Andreani: sin cobertura para la localidad, devuelve lista vacía (no un error)", async () => {
  resetCheckoutDestinationStateForTests()

  const result = await getCheckoutPostalCodes("San Juan", "San Juan", {
    fetch: fakeGeorefFetch(georefResponse(["SAN JUAN"])),
    getAndreaniLocalities: async () => {
      throw new AndreaniError("REQUEST_FAILED", "no encontrado", { status: 404 })
    },
  })

  assert.deepEqual(result.postalCodes, [])
})

test("una localidad que no pertenece a la provincia elegida se rechaza server-side", async () => {
  resetCheckoutDestinationStateForTests()

  await assert.rejects(
    () =>
      getCheckoutPostalCodes("Jujuy", "Puerto Madryn", {
        fetch: fakeGeorefFetch(georefResponse(["SAN SALVADOR DE JUJUY"])),
        getAndreaniLocalities: async () => {
          throw new Error("no debería llamarse a Andreani sin localidad válida")
        },
      }),
    (error: unknown) =>
      error instanceof AndreaniError &&
      error.code === "VALIDATION_ERROR" &&
      error.message === "La localidad no corresponde a la provincia seleccionada.",
  )
})

test("isCheckoutDestinationCached sólo confirma un CP realmente cacheado para esa localidad", async () => {
  resetCheckoutDestinationStateForTests()

  assert.equal(isCheckoutDestinationCached("Chubut", "Puerto Madryn", "9120"), false)

  await getCheckoutPostalCodes("Chubut", "Puerto Madryn", {
    fetch: fakeGeorefFetch(georefResponse(["PUERTO MADRYN"])),
    getAndreaniLocalities: async () => [
      { idDeProvLocalidad: 1, localidad: "PUERTO MADRYN", provincia: "CHUBUT", codigosPostales: ["9120"] },
    ],
  })

  assert.equal(isCheckoutDestinationCached("Chubut", "Puerto Madryn", "9120"), true)
  assert.equal(
    isCheckoutDestinationCached("Chubut", "Puerto Madryn", "9999"),
    false,
    "un CP que no vino en la respuesta real nunca debe darse por cacheado",
  )
})

test("cambiar de provincia no reutiliza el catálogo de localidades de otra (sin contaminación de caché)", async () => {
  resetCheckoutDestinationStateForTests()

  const jujuy = await getCheckoutProvinceLocalities("Jujuy", {
    fetch: fakeGeorefFetch(georefResponse(["SAN SALVADOR DE JUJUY"])),
  })
  const chubut = await getCheckoutProvinceLocalities("Chubut", {
    fetch: fakeGeorefFetch(georefResponse(["PUERTO MADRYN", "TRELEW"])),
  })

  assert.deepEqual(jujuy.map((l) => l.name), ["SAN SALVADOR DE JUJUY"])
  assert.deepEqual(chubut.map((l) => l.name).sort(), ["PUERTO MADRYN", "TRELEW"])
})

test("el catálogo de referencia territorial ya no fuerza QA -- usa el mismo ambiente que la tarifa", () => {
  const source = readFileSync(new URL("./checkout-destinations.ts", import.meta.url), "utf8")

  assert.doesNotMatch(
    source,
    /ANDREANI_ENV:\s*["']QA["']/,
    "checkout-destinations.ts no debe volver a hardcodear QA: el catálogo de localidades/CP debe resolver el ambiente igual que la cotización real (ver resolveAndreaniReferenceEnvironment), o QA y PROD pueden devolver nomenclatura distinta para el mismo destino",
  )
  assert.match(source, /resolveAndreaniReferenceEnvironment/)
})

test("la ruta de destinos territoriales nunca usa Cache-Control público/compartido", () => {
  const source = readFileSync(
    new URL("../../app/api/andreani/destinos/route.ts", import.meta.url),
    "utf8",
  )

  assert.doesNotMatch(
    source,
    /Cache-Control["']?\s*:\s*["']public/,
    "un Cache-Control público en esta ruta ya causó que la CDN de Netlify sirviera la respuesta de una provincia para otra distinta (colisión de caché de borde, no varía por query string)",
  )
})
