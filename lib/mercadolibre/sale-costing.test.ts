import assert from "node:assert/strict"
import test from "node:test"

import { summarizeMercadoLibreCosting } from "./sale-costing.ts"

function costedRow(units: number, unitCost: number, netAmount: number) {
  return {
    net_amount: netAmount,
    costing: {
      costable_units: units,
      merchandise_cost: Math.round(unitCost * units * 100) / 100,
    },
  }
}

function pendingRow(units: number, netAmount: number) {
  return {
    net_amount: netAmount,
    costing: {
      costable_units: units,
      merchandise_cost: null,
    },
  }
}

test("5/7 unidades con costo muestra la ganancia parcial real de esas 5", () => {
  // 5 unidades costeadas: costo 1000 c/u, ingreso neto 9000.
  // 2 unidades pendientes: sin costo, ingreso neto 3600 (no debe entrar al cálculo).
  const summary = summarizeMercadoLibreCosting([
    costedRow(5, 1000, 9000),
    pendingRow(2, 3600),
  ])

  assert.equal(summary.totalCostableUnits, 7)
  assert.equal(summary.coveredUnits, 5)
  assert.equal(summary.merchandiseCost, 5000)
  assert.equal(summary.exact, false)
  assert.equal(summary.isPartial, true)
  // Ganancia = ingresos de las 5 costeadas (9000) - su costo (5000).
  assert.equal(summary.profit, 4000)
})

test("las unidades pendientes nunca se calculan como costo 0", () => {
  const withPending = summarizeMercadoLibreCosting([
    costedRow(5, 1000, 9000),
    pendingRow(2, 3600),
  ])
  const withoutPendingRow = summarizeMercadoLibreCosting([
    costedRow(5, 1000, 9000),
  ])

  // Si las 2 pendientes entraran con costo 0, su ingreso (3600) inflaría
  // la ganancia parcial. El resultado debe ser idéntico con o sin la fila
  // pendiente presente.
  assert.equal(withPending.profit, withoutPendingRow.profit)
  assert.equal(withPending.merchandiseCost, withoutPendingRow.merchandiseCost)
})

test("al completarse el costo histórico faltante pasa a 7/7 y recalcula", () => {
  const before = summarizeMercadoLibreCosting([
    costedRow(5, 1000, 9000),
    pendingRow(2, 3600),
  ])
  assert.equal(before.exact, false)
  assert.equal(before.profit, 4000)

  // Se carga la compra faltante: la misma fila ahora informa su costo.
  const after = summarizeMercadoLibreCosting([
    costedRow(5, 1000, 9000),
    costedRow(2, 900, 3600),
  ])

  assert.equal(after.coveredUnits, 7)
  assert.equal(after.totalCostableUnits, 7)
  assert.equal(after.exact, true)
  assert.equal(after.isPartial, false)
  assert.equal(after.merchandiseCost, 5000 + 1800)
  assert.equal(after.profit, 9000 + 3600 - (5000 + 1800))
})

test("si ninguna unidad tiene costo, recién ahí el resultado es null (Pendiente)", () => {
  const summary = summarizeMercadoLibreCosting([
    pendingRow(3, 5000),
    pendingRow(4, 6000),
  ])

  assert.equal(summary.profit, null)
  assert.equal(summary.coveredUnits, 0)
  assert.equal(summary.totalCostableUnits, 7)
  assert.equal(summary.exact, false)
  assert.equal(summary.isPartial, false)
})

test("no produce NaN ni márgenes engañosos con filas vacías o costos en 0", () => {
  const empty = summarizeMercadoLibreCosting([])
  assert.equal(Number.isNaN(empty.profit ?? 0), false)
  assert.equal(empty.merchandiseCost, 0)

  const zeroCostable = summarizeMercadoLibreCosting([
    { net_amount: 0, costing: { costable_units: 0, merchandise_cost: 0 } },
  ])
  assert.equal(zeroCostable.exact, true)
  assert.equal(zeroCostable.profit, 0)
  assert.equal(Number.isFinite(zeroCostable.profit), true)

  const malformed = summarizeMercadoLibreCosting([
    { net_amount: "no-numero" as unknown as number, costing: { costable_units: "x" as unknown as number, merchandise_cost: 100 } },
  ])
  assert.equal(Number.isNaN(malformed.profit ?? 0), false)
  assert.equal(Number.isFinite(malformed.profit ?? 0), true)
})

test("un error de costeo fuerza Pendiente aunque haya filas con costo conocido", () => {
  const summary = summarizeMercadoLibreCosting(
    [costedRow(5, 1000, 9000)],
    true,
  )

  assert.equal(summary.exact, false)
  assert.equal(summary.isPartial, false)
  assert.equal(summary.profit, null)
})

test("una fila sin objeto costing cuenta como pendiente, no como costo 0", () => {
  const summary = summarizeMercadoLibreCosting([
    costedRow(5, 1000, 9000),
    { net_amount: 1000 },
  ])

  assert.equal(summary.totalCostableUnits, 5)
  assert.equal(summary.coveredUnits, 5)
  assert.equal(summary.exact, false)
  assert.equal(summary.isPartial, true)
  assert.equal(summary.profit, 4000)
})
