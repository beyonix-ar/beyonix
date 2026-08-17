import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

function readRoute(relativePath: string) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8")
}

test("el endpoint de etiqueta exige admin, andreani_envio_id y usa el ambiente donde se creó el envío", () => {
  const source = readRoute("../../app/api/andreani/etiqueta/route.ts")

  assert.match(source, /requireInternalUser\(request, \["admin", "super_admin"\]\)/)
  assert.match(source, /andreani_envio_id/)
  assert.match(
    source,
    /El pedido todavía no tiene un envío Andreani generado/,
  )
  assert.match(source, /andreani_creation_environment/)
  assert.match(source, /getEtiquetas\(/)
  // No debe pedir autorización PROD implícitamente para este endpoint.
  assert.doesNotMatch(source, /productionAccess:\s*"shipment-creation"/)
})

test("el endpoint de tracking exige admin, andreani_tracking y usa el ambiente donde se creó el envío", () => {
  const source = readRoute("../../app/api/andreani/tracking/route.ts")

  assert.match(source, /requireInternalUser\(request, \["admin", "super_admin"\]\)/)
  assert.match(source, /andreani_tracking/)
  assert.match(
    source,
    /El pedido todavía no tiene tracking Andreani disponible/,
  )
  assert.match(source, /andreani_creation_environment/)
  assert.match(source, /getTrackingPullV3\(/)
  assert.doesNotMatch(source, /productionAccess:\s*"shipment-creation"/)
})

test("ninguna de las dos rutas expone el body completo de Andreani ni credenciales en la respuesta de error", () => {
  for (const path of [
    "../../app/api/andreani/etiqueta/route.ts",
    "../../app/api/andreani/tracking/route.ts",
  ]) {
    const source = readRoute(path)
    assert.doesNotMatch(source, /x-authorization-token/i)
    assert.doesNotMatch(source, /ANDREANI_(QA|PROD)_(USERNAME|PASSWORD)/)
    assert.doesNotMatch(source, /console\.(error|info|log)\([^)]*payload/i)
    assert.match(source, /normalizeAndreaniError\(error\)/)
  }
})
