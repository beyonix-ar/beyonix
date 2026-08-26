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
  assert.match(source, /productionAccess:[\s\S]*?"shipment-read"/)
  assert.doesNotMatch(source, /productionAccess:\s*"shipment-creation"/)
})

test("el endpoint de tracking exige admin, andreani_tracking y usa el ambiente donde se creó el envío", () => {
  const source = readRoute("../../app/api/andreani/tracking/route.ts")

  assert.match(source, /requireInternalUser\(request, \["admin", "super_admin"\]\)/)
  assert.match(source, /andreani_tracking/)
  assert.match(source, /andreani_envio_id/)
  assert.match(
    source,
    /El pedido todavía no tiene un envío Andreani generado/,
  )
  assert.match(source, /andreani_creation_environment/)
  assert.match(source, /getTrackingPullV3\(/)
  assert.match(source, /getEstadoOrden\(/)
  assert.match(source, /andreani_tracking_checked_at/)
  assert.match(source, /productionAccess:[\s\S]*?"shipment-read"/)
  assert.doesNotMatch(source, /productionAccess:\s*"shipment-creation"/)
  assert.doesNotMatch(source, /delivered_at/)
  assert.doesNotMatch(source, /estado:\s*"entregado"/)
})

test("el endpoint de tracking siempre consulta getEstadoOrden, incluso con tracking ya conocido", () => {
  const source = readRoute("../../app/api/andreani/tracking/route.ts")

  // Regresión: antes se omitía getEstadoOrden apenas existía
  // andreani_tracking, así que un rechazo posterior a la creación
  // ("Rechazado") nunca se detectaba desde "Consultar".
  assert.doesNotMatch(source, /numeroDeTracking\s*\?\s*null\s*:/)
  assert.match(source, /const orderStatus = await getEstadoOrden\(/)
  assert.match(source, /orderStatus\.estado === "Rechazado"/)
})

test("el endpoint de tracking prioriza el evento con Estado legible sobre el evento técnicamente más reciente", () => {
  const source = readRoute("../../app/api/andreani/tracking/route.ts")

  // Regresión: tomar ciegamente el evento más reciente por fecha podía
  // pisar un estado legible ("Pendiente de ingreso") con el código interno
  // de un evento posterior sin Estado (p. ej. "OrdenDeEnvioCreada").
  assert.match(source, /sortedEvents\.find\(\(event\) => event\.Estado\)/)
  assert.doesNotMatch(source, /latestEvent\.Estado \?\? latestEvent\.Evento/)
})

test("el endpoint de tracking siempre devuelve un mensaje visible, incluso sin eventos nuevos", () => {
  const source = readRoute("../../app/api/andreani/tracking/route.ts")

  assert.match(source, /El envío continúa: \$\{logisticsEstado\}/)
  assert.match(source, /rechazó la orden después de haberla creado/)
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
