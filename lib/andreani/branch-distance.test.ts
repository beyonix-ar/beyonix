import assert from "node:assert/strict"
import test from "node:test"

import {
  haversineDistanceKm,
  parseAndreaniBranchCoordinates,
  sortAndreaniBranchesByDistance,
} from "./branch-distance.ts"
import type { AndreaniBranch } from "./types.ts"

function branch(overrides: Partial<AndreaniBranch> & { id: number }): AndreaniBranch {
  return {
    codigo: `COD${overrides.id}`,
    numero: String(overrides.id),
    descripcion: `Sucursal ${overrides.id}`,
    canal: "B2C",
    direccion: {
      calle: "Calle falsa",
      numero: "123",
      provincia: "Santa Fe",
      localidad: "Rosario",
      region: "Litoral",
      pais: "Argentina",
      codigoPostal: "2000",
    },
    ...overrides,
  }
}

test("haversineDistanceKm: distancia cero entre el mismo punto", () => {
  const point = { lat: -32.9468, lng: -60.6393 }
  assert.equal(haversineDistanceKm(point, point), 0)
})

test("haversineDistanceKm: distancia real conocida entre Rosario y Santa Fe (~150km) dentro de un margen razonable", () => {
  const rosario = { lat: -32.9468, lng: -60.6393 }
  const santaFe = { lat: -31.6333, lng: -60.7 }
  const distance = haversineDistanceKm(rosario, santaFe)
  assert.ok(distance > 140 && distance < 160, `esperaba ~150km, dio ${distance}`)
})

test("parseAndreaniBranchCoordinates: coordenadas reales válidas se parsean a número", () => {
  const point = parseAndreaniBranchCoordinates(
    branch({ id: 1, coordenadas: { latitud: "-32.962580", longitud: "-60.640600" } }),
  )
  assert.deepEqual(point, { lat: -32.96258, lng: -60.6406 })
})

test("parseAndreaniBranchCoordinates: sin coordenadas en la respuesta real, devuelve null (nunca inventa)", () => {
  assert.equal(parseAndreaniBranchCoordinates(branch({ id: 1 })), null)
})

test("sortAndreaniBranchesByDistance: sin origen conocido, devuelve las sucursales tal cual (sin distanciaKm, sin orden inventado)", () => {
  const branches = [
    branch({ id: 1, coordenadas: { latitud: "-32.9", longitud: "-60.6" } }),
    branch({ id: 2, coordenadas: { latitud: "-33.0", longitud: "-60.7" } }),
  ]
  const result = sortAndreaniBranchesByDistance(branches, null)
  assert.deepEqual(result, branches)
})

test("sortAndreaniBranchesByDistance: ordena de más cercana a más lejana y adjunta distanciaKm", () => {
  const origin = { lat: -32.9468, lng: -60.6393 }
  const lejana = branch({
    id: 1,
    descripcion: "Lejana",
    coordenadas: { latitud: "-33.015652", longitud: "-60.667958" },
  })
  const cercana = branch({
    id: 2,
    descripcion: "Cercana",
    coordenadas: { latitud: "-32.962580", longitud: "-60.640600" },
  })
  const result = sortAndreaniBranchesByDistance([lejana, cercana], origin)

  assert.equal(result[0].id, 2)
  assert.equal(result[1].id, 1)
  assert.ok(typeof result[0].distanciaKm === "number")
  assert.ok(result[0].distanciaKm! < result[1].distanciaKm!)
})

test("sortAndreaniBranchesByDistance: una sucursal sin coordenadas propias queda al final, no se descarta", () => {
  const origin = { lat: -32.9468, lng: -60.6393 }
  const conCoordenadas = branch({
    id: 1,
    coordenadas: { latitud: "-32.962580", longitud: "-60.640600" },
  })
  const sinCoordenadas = branch({ id: 2 })
  const result = sortAndreaniBranchesByDistance([sinCoordenadas, conCoordenadas], origin)

  assert.equal(result.length, 2)
  assert.equal(result[0].id, 1)
  assert.equal(result[1].id, 2)
  assert.equal(result[1].distanciaKm, undefined)
})
