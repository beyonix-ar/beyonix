import assert from "node:assert/strict"
import test from "node:test"

import { getPendingReturnAdjustment, getUncoveredReturnedQuantity } from "./return-profitability.ts"

// Auditoría 4/7 (P0 confirmado con evidencia numérica): venta $30.000, costo
// histórico $10.000, producto sano devuelto y recepción física confirmada,
// nota de crédito TODAVÍA sin autorizar. El dashboard no debe mostrar
// ganancia por esa venta mientras la NC esté pendiente.

test("R. recepción confirmada + NC pendiente: el ajuste cubre el ingreso íntegro de la unidad devuelta (no se muestra ganancia artificial)", () => {
  const adjustment = getPendingReturnAdjustment(30_000, 1, 0)
  assert.equal(adjustment, 30_000)
})

test("S. NC ya autorizada y cubre la cantidad recibida: el ajuste vuelve a 0 (webCompletedRefunds ya lo restó, no se descuenta dos veces)", () => {
  const adjustment = getPendingReturnAdjustment(30_000, 1, 1)
  assert.equal(adjustment, 0)
})

test("devolución parcial: sólo se ajusta la porción recibida y no cubierta todavía", () => {
  // 3 unidades vendidas, se reciben físicamente 2, ninguna nota de crédito
  // autorizada todavía -- el ajuste es sólo por esas 2, no por las 3.
  const adjustment = getPendingReturnAdjustment(10_000, 2, 0)
  assert.equal(adjustment, 20_000)
})

test("NC parcial ya autorizada: el ajuste cubre sólo lo que falta acreditar", () => {
  // Se recibieron físicamente 3 unidades, la NC autorizada hasta ahora sólo
  // cubrió 1 -- el ajuste pendiente es por las 2 restantes, no las 3.
  const adjustment = getPendingReturnAdjustment(10_000, 3, 1)
  assert.equal(adjustment, 20_000)
})

test("sin recepción física todavía: no hay ajuste (la venta sigue siendo una venta normal)", () => {
  assert.equal(getPendingReturnAdjustment(30_000, 0, 0), 0)
})

test("la NC no puede sobre-cubrir: creditedQuantity mayor a lo recibido nunca produce un ajuste negativo", () => {
  assert.equal(getPendingReturnAdjustment(30_000, 1, 5), 0)
})

test("getUncoveredReturnedQuantity: nunca negativo, nunca cuenta más que lo recibido", () => {
  assert.equal(getUncoveredReturnedQuantity(2, 0), 2)
  assert.equal(getUncoveredReturnedQuantity(2, 1), 1)
  assert.equal(getUncoveredReturnedQuantity(2, 2), 0)
  assert.equal(getUncoveredReturnedQuantity(2, 10), 0)
  assert.equal(getUncoveredReturnedQuantity(-5, 0), 0)
})
