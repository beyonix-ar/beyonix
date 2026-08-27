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

test("el endpoint de tracking exige admin y delega en el sync compartido con el ambiente donde se creó el envío", () => {
  const source = readRoute("../../app/api/andreani/tracking/route.ts")

  assert.match(source, /requireInternalUser\(request, \["admin", "super_admin"\]\)/)
  assert.match(source, /andreani_tracking/)
  assert.match(source, /andreani_envio_id/)
  assert.match(source, /andreani_creation_environment/)
  assert.match(source, /syncAndreaniOrderTracking\(/)
  assert.match(source, /resolveAndreaniTrackingEnvironment\(/)
})

// La lógica real (getEstadoOrden/getTrackingPullV3, prioridad de Estado,
// timestamps, transición automática) vive ahora en un único módulo
// compartido -- ver lib/andreani/order-tracking-sync.test.ts -- para que el
// botón "Consultar" y la sincronización automática (cron) nunca diverjan.
test("el criterio real de tracking vive en un único módulo compartido, no duplicado en la ruta", () => {
  const source = readRoute("../../lib/andreani/order-tracking-sync.ts")

  assert.match(source, /El pedido todavía no tiene un envío Andreani generado/)
  assert.match(source, /const orderStatus = await getEstadoOrden\(/)
  assert.match(source, /orderStatus\.estado === "Rechazado"/)
  assert.match(source, /sortedEvents\.find\(\(event\) => event\.Estado\)/)
  assert.doesNotMatch(source, /latestEvent\.Estado \?\? latestEvent\.Evento/)
  assert.match(source, /andreani_tracking_checked_at/)
  assert.match(source, /parseAndreaniTimestamp\(/)

  const routeSource = readRoute("../../app/api/andreani/tracking/route.ts")
  assert.doesNotMatch(routeSource, /getTrackingPullV3\(/)
  assert.doesNotMatch(routeSource, /getEstadoOrden\(/)
})

test("el endpoint de tracking siempre devuelve un mensaje visible, incluso sin eventos nuevos", () => {
  const source = readRoute("../../app/api/andreani/tracking/route.ts")

  assert.match(source, /El envío continúa: \$\{snapshot\.logisticsEstado\}/)
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
