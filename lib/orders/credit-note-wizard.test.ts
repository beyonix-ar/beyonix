import assert from "node:assert/strict"
import test from "node:test"

import { canProceedPastProductsStep, operationRequiresClaim } from "./credit-note-wizard.ts"

test("productos seleccionados sin ajuste manual: permite avanzar", () => {
  assert.equal(canProceedPastProductsStep("devolucion_parcial", 2), true)
})

test("ajuste manual válido sin productos seleccionados: permite avanzar", () => {
  assert.equal(canProceedPastProductsStep("ajuste_manual", 0), true)
  assert.equal(canProceedPastProductsStep("reembolso_excepcional", 0), true)
})

test("productos seleccionados y ajuste manual: permite avanzar", () => {
  assert.equal(canProceedPastProductsStep("ajuste_manual", 3), true)
})

test("ninguno de los dos (sin productos y tipo de gestión que sí los requiere): bloquea", () => {
  assert.equal(canProceedPastProductsStep("devolucion_parcial", 0), false)
  assert.equal(canProceedPastProductsStep("devolucion_total", 0), false)
  assert.equal(canProceedPastProductsStep("cambio_producto", 0), false)
  assert.equal(canProceedPastProductsStep("cancelacion_antes_despacho", 0), false)
})

test("operationRequiresClaim: devoluciones/cambios/cancelación iniciados por el cliente exigen reclamo", () => {
  assert.equal(operationRequiresClaim("devolucion_parcial"), true)
  assert.equal(operationRequiresClaim("devolucion_total"), true)
  assert.equal(operationRequiresClaim("cambio_producto"), true)
  assert.equal(operationRequiresClaim("cancelacion_antes_despacho"), true)
})

test("operationRequiresClaim: ajustes administrativos/contables no exigen reclamo", () => {
  assert.equal(operationRequiresClaim("ajuste_manual"), false)
  assert.equal(operationRequiresClaim("reembolso_excepcional"), false)
})
