import assert from "node:assert/strict"
import test from "node:test"

import { ANDREANI_TRACKING_EVENTS } from "./types.ts"
import {
  assertAllAndreaniEventsAreMapped,
  mapAndreaniEventToLogisticsPhase,
  resolveAndreaniAutoOrderTransition,
} from "./tracking-status-mapping.ts"

test("todo el maestro de eventos Andreani tiene mapping (exhaustivo)", () => {
  assert.doesNotThrow(() => assertAllAndreaniEventsAreMapped())
  for (const evento of ANDREANI_TRACKING_EVENTS) {
    assert.ok(typeof mapAndreaniEventToLogisticsPhase(evento) === "string")
  }
})

test("EnvioEntregado mapea a la fase entregado", () => {
  assert.equal(mapAndreaniEventToLogisticsPhase("EnvioEntregado"), "entregado")
})

test("EnvioDespachado mapea a en_camino; OrdenDeEnvioSolicitada mapea a orden_creada", () => {
  assert.equal(mapAndreaniEventToLogisticsPhase("EnvioDespachado"), "en_camino")
  assert.equal(mapAndreaniEventToLogisticsPhase("OrdenDeEnvioSolicitada"), "orden_creada")
  assert.equal(mapAndreaniEventToLogisticsPhase("OrdenDeEnvioCreada"), "orden_creada")
})

function events(...eventos: string[]) {
  return eventos.map((Evento) => ({ Evento: Evento as never }))
}

test("EnvioEntregado real -> transición automática a entregado desde cualquier estado activo", () => {
  assert.equal(
    resolveAndreaniAutoOrderTransition(events("OrdenDeEnvioCreada", "EnvioDespachado", "EnvioEntregado"), "pagado"),
    "entregado",
  )
  assert.equal(
    resolveAndreaniAutoOrderTransition(events("EnvioEntregado"), "en_camino"),
    "entregado",
  )
})

test("EnvioDespachado real -> en_camino sólo desde pendiente/pagado", () => {
  assert.equal(resolveAndreaniAutoOrderTransition(events("EnvioDespachado"), "pagado"), "en_camino")
  assert.equal(resolveAndreaniAutoOrderTransition(events("EnvioDespachado"), "pendiente"), "en_camino")
})

test("EnvioDespachado NO avanza un pedido que ya tiene un estado de despacho más específico", () => {
  for (const estado of ["enviado", "en_camino", "en_sucursal", "retiro_pendiente", "visita_fallida"]) {
    assert.equal(resolveAndreaniAutoOrderTransition(events("EnvioDespachado"), estado), null)
  }
})

test("nunca avanza a en_camino sólo porque existe tracking/orden creada (Pendiente de ingreso)", () => {
  assert.equal(
    resolveAndreaniAutoOrderTransition(events("OrdenDeEnvioSolicitada"), "pagado"),
    null,
  )
  assert.equal(
    resolveAndreaniAutoOrderTransition(events("OrdenDeEnvioCreada"), "pendiente"),
    null,
  )
  assert.equal(resolveAndreaniAutoOrderTransition([], "pagado"), null)
})

test("nunca toca un pedido ya cerrado (entregado/cancelado/devuelto/en devolución)", () => {
  for (const estado of ["entregado", "cancelado", "devuelto_beyonix", "en_devolucion"]) {
    assert.equal(
      resolveAndreaniAutoOrderTransition(events("EnvioEntregado"), estado),
      null,
      `no debería tocar un pedido en estado ${estado}`,
    )
    assert.equal(
      resolveAndreaniAutoOrderTransition(events("EnvioDespachado"), estado),
      null,
    )
  }
})
