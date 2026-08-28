import assert from "node:assert/strict"
import test from "node:test"

import {
  buildProductCostLedgers,
  getHistoricalUnitCost,
  getWorstCaseKnownCost,
  resolveProductVariantCosts,
  type ProductCostLedgerRow,
} from "./product-costs.ts"

function row(overrides: Partial<ProductCostLedgerRow> = {}): ProductCostLedgerRow {
  return {
    product_id: 1,
    variant_id: null,
    purchase_date: "2026-01-01",
    quantity: 1,
    total_cost: 1000,
    ...overrides,
  }
}

test("costo a nivel producto (sin variantes): getHistoricalUnitCost resuelve por p:<id>", () => {
  const ledgers = buildProductCostLedgers([
    row({ product_id: 1, variant_id: null, quantity: 2, total_cost: 2000 }),
  ])
  assert.equal(getHistoricalUnitCost(ledgers, 1, null, "2026-06-01"), 1000)
})

test("costo a nivel variante: variantId=null NUNCA encuentra una compra cargada contra una variante puntual -- causa raíz del bug ART-TEST", () => {
  // Un producto CON variantes nunca se compra "a nivel producto" (ver Admin >
  // Costos): la compra siempre queda con variant_id=10, no null.
  const ledgers = buildProductCostLedgers([
    row({ product_id: 1, variant_id: 10, quantity: 2, total_cost: 2000 }),
  ])
  assert.equal(getHistoricalUnitCost(ledgers, 1, null, "2026-06-01"), null)
  assert.equal(getHistoricalUnitCost(ledgers, 1, 10, "2026-06-01"), 1000)
})

test("resolveProductVariantCosts: producto sin variantes resuelve a nivel producto (sin cambios de comportamiento)", () => {
  const ledgers = buildProductCostLedgers([
    row({ product_id: 5, variant_id: null, quantity: 3, total_cost: 3000 }),
  ])
  const resolutions = resolveProductVariantCosts(ledgers, 5, [], "2026-06-01")
  assert.deepEqual(resolutions, [{ variantId: null, variantName: null, unitCost: 1000 }])
})

test("resolveProductVariantCosts: producto con UNA sola variante usa el costo de esa variante (caso ART-TEST · NEGRO)", () => {
  const ledgers = buildProductCostLedgers([
    row({ product_id: 7, variant_id: 70, quantity: 2, total_cost: 2000 }),
  ])
  const resolutions = resolveProductVariantCosts(
    ledgers,
    7,
    [{ id: 70, nombre: "NEGRO" }],
    "2026-06-01",
  )
  assert.deepEqual(resolutions, [{ variantId: 70, variantName: "NEGRO", unitCost: 1000 }])
  assert.equal(getWorstCaseKnownCost(resolutions), 1000)
})

test("resolveProductVariantCosts: múltiples variantes con el MISMO costo", () => {
  const ledgers = buildProductCostLedgers([
    row({ product_id: 8, variant_id: 80, quantity: 1, total_cost: 500 }),
    row({ product_id: 8, variant_id: 81, quantity: 1, total_cost: 500 }),
  ])
  const resolutions = resolveProductVariantCosts(
    ledgers,
    8,
    [
      { id: 80, nombre: "ROJO" },
      { id: 81, nombre: "AZUL" },
    ],
    "2026-06-01",
  )
  assert.deepEqual(
    resolutions.map((r) => r.unitCost),
    [500, 500],
  )
  assert.equal(getWorstCaseKnownCost(resolutions), 500)
})

test("resolveProductVariantCosts: múltiples variantes con costos DISTINTOS -- nunca se colapsan en un número inventado", () => {
  const ledgers = buildProductCostLedgers([
    row({ product_id: 9, variant_id: 90, quantity: 1, total_cost: 500 }),
    row({ product_id: 9, variant_id: 91, quantity: 1, total_cost: 1500 }),
  ])
  const resolutions = resolveProductVariantCosts(
    ledgers,
    9,
    [
      { id: 90, nombre: "CHICO" },
      { id: 91, nombre: "GRANDE" },
    ],
    "2026-06-01",
  )
  assert.deepEqual(
    resolutions.map((r) => ({ variantId: r.variantId, unitCost: r.unitCost })),
    [
      { variantId: 90, unitCost: 500 },
      { variantId: 91, unitCost: 1500 },
    ],
  )
  // Ni un promedio (1000) ni el menor: el costo de referencia para fijar
  // precio es el PEOR caso (mayor), para no arriesgar el margen en GRANDE.
  assert.equal(getWorstCaseKnownCost(resolutions), 1500)
})

test("resolveProductVariantCosts: variante sin costo cargado devuelve null para esa variante, no 0 ni el costo de otra", () => {
  const ledgers = buildProductCostLedgers([
    row({ product_id: 11, variant_id: 110, quantity: 1, total_cost: 800 }),
  ])
  const resolutions = resolveProductVariantCosts(
    ledgers,
    11,
    [
      { id: 110, nombre: "CON COSTO" },
      { id: 111, nombre: "SIN COSTO" },
    ],
    "2026-06-01",
  )
  assert.equal(resolutions.find((r) => r.variantId === 110)?.unitCost, 800)
  assert.equal(resolutions.find((r) => r.variantId === 111)?.unitCost, null)
})

test("getHistoricalUnitCost: costo promedio ponderado por fecha, no un promedio simple de precios de compra", () => {
  const ledgers = buildProductCostLedgers([
    row({ product_id: 12, variant_id: 120, purchase_date: "2026-01-01", quantity: 2, total_cost: 2000 }), // $1.000/u
    row({ product_id: 12, variant_id: 120, purchase_date: "2026-03-01", quantity: 2, total_cost: 3000 }), // $1.500/u
  ])
  // Antes de la segunda compra: sólo la primera cuenta.
  assert.equal(getHistoricalUnitCost(ledgers, 12, 120, "2026-02-01"), 1000)
  // Después de ambas: (2000+3000)/(2+2) = 1250 ponderado por cantidad, no
  // (1000+1500)/2 = 1250 por coincidencia en este ejemplo -- se verifica con
  // cantidades desiguales en el siguiente caso para no dejar ambigüedad.
  assert.equal(getHistoricalUnitCost(ledgers, 12, 120, "2026-06-01"), 1250)
})

test("getHistoricalUnitCost: el ponderado pesa por cantidad, no por cantidad de compras", () => {
  const ledgers = buildProductCostLedgers([
    row({ product_id: 14, variant_id: 140, purchase_date: "2026-01-01", quantity: 1, total_cost: 1000 }), // $1.000/u
    row({ product_id: 14, variant_id: 140, purchase_date: "2026-03-01", quantity: 9, total_cost: 18000 }), // $2.000/u, 9 unidades
  ])
  // (1000 + 18000) / (1 + 9) = 1900, mucho más cerca de $2.000 que un
  // promedio simple de precios ((1000+2000)/2 = 1500) porque hay 9x más
  // unidades a $2.000 que a $1.000.
  assert.equal(getHistoricalUnitCost(ledgers, 14, 140, "2026-06-01"), 1900)
})

test("producto sin cost entries: ninguna variante tiene costo conocido, nunca se inventa un valor", () => {
  const ledgers = buildProductCostLedgers([])

  // Sin variantes.
  const withoutVariants = resolveProductVariantCosts(ledgers, 15, [], "2026-06-01")
  assert.deepEqual(withoutVariants, [{ variantId: null, variantName: null, unitCost: null }])
  assert.equal(getWorstCaseKnownCost(withoutVariants), null)

  // Con variantes, ninguna con compras cargadas.
  const withVariants = resolveProductVariantCosts(
    ledgers,
    16,
    [
      { id: 160, nombre: "NEGRO" },
      { id: 161, nombre: "BLANCO" },
    ],
    "2026-06-01",
  )
  assert.deepEqual(
    withVariants.map((r) => r.unitCost),
    [null, null],
  )
  assert.equal(getWorstCaseKnownCost(withVariants), null)
})
