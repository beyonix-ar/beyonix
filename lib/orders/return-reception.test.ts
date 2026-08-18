import assert from "node:assert/strict"
import test from "node:test"

import {
  isPhysicallyReceivedStatus,
  normalizeStockDestination,
} from "./return-reception.ts"

test("los cuatro estados de recepción física habilitan stockDestination", () => {
  for (const status of [
    "recibido_revision",
    "producto_aprobado",
    "producto_rechazado",
    "aprobado_parcial",
  ]) {
    assert.equal(isPhysicallyReceivedStatus(status), true)
  }
})

test("los estados sin recepción física no habilitan stockDestination", () => {
  for (const status of ["no_requiere", "pendiente_despacho", "en_transito"]) {
    assert.equal(isPhysicallyReceivedStatus(status), false)
  }
})

test("normalizeStockDestination conserva el valor elegido cuando la recepción es física", () => {
  assert.equal(
    normalizeStockDestination("producto_aprobado", "stock_vendible"),
    "stock_vendible",
  )
})

test("normalizeStockDestination descarta un valor stale cuando la recepción cambia a no física", () => {
  // Reproduce el escenario reportado: se eligió un stockDestination con
  // recepción física, y luego el estado de recepción se cambió a uno que no
  // requiere revisión — el valor elegido no debe persistir.
  assert.equal(
    normalizeStockDestination("no_requiere", "stock_vendible"),
    "pendiente_revision",
  )
  assert.equal(
    normalizeStockDestination("pendiente_despacho", "fallado"),
    "pendiente_revision",
  )
})
