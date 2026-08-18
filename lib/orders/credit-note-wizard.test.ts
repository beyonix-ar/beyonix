import assert from "node:assert/strict"
import test from "node:test"

import { canProceedPastProductsStep } from "./credit-note-wizard.ts"

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
