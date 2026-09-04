import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  buildProductCostLedgers,
  getHistoricalUnitCost,
  getReceivedCostContribution,
  getTargetMarginCostBasisError,
  getWorstCaseKnownCost,
  resolveProductVariantCosts,
  resolveTargetMarginCostBasis,
  type ProductCostLedgerRow,
} from "./product-costs.ts"

function row(overrides: Partial<ProductCostLedgerRow> = {}): ProductCostLedgerRow {
  return {
    product_id: 1,
    variant_id: null,
    purchase_date: "2026-01-01",
    quantity: 1,
    received_quantity: null,
    reception_status: "recibida",
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

// --- Compras que todavía NO son mercadería incorporada (P1 costos históricos) ---

test("una compra ANULADA no contamina el costo histórico", () => {
  const ledgers = buildProductCostLedgers([
    row({ product_id: 20, variant_id: 200, quantity: 1, total_cost: 1000, received_quantity: 1 }),
    row({
      product_id: 20,
      variant_id: 200,
      purchase_date: "2026-02-01",
      quantity: 10,
      total_cost: 999999,
      reception_status: "anulada",
      received_quantity: 0,
    }),
  ])

  assert.equal(getHistoricalUnitCost(ledgers, 20, 200, "2026-06-01"), 1000)
})

test("una compra PENDIENTE (nada recibido) no contamina el costo histórico", () => {
  const ledgers = buildProductCostLedgers([
    row({ product_id: 21, variant_id: 210, quantity: 1, total_cost: 1000, received_quantity: 1 }),
    row({
      product_id: 21,
      variant_id: 210,
      purchase_date: "2026-02-01",
      quantity: 4,
      total_cost: 40000,
      reception_status: "pendiente",
      received_quantity: 0,
    }),
  ])

  assert.equal(getHistoricalUnitCost(ledgers, 21, 210, "2026-06-01"), 1000)
})

test("una compra PARCIAL aporta sólo las unidades recibidas y su costo proporcional", () => {
  // 10 unidades por $1.000 en total; se recibieron 2 => $200 por 2 unidades.
  const ledgers = buildProductCostLedgers([
    row({
      product_id: 22,
      variant_id: 220,
      quantity: 10,
      total_cost: 1000,
      reception_status: "parcial",
      received_quantity: 2,
    }),
  ])

  assert.equal(getHistoricalUnitCost(ledgers, 22, 220, "2026-06-01"), 100)
})

test("una compra RECIBIDA aporta la compra completa (comportamiento histórico)", () => {
  const ledgers = buildProductCostLedgers([
    row({ product_id: 23, variant_id: 230, quantity: 4, total_cost: 4000 }),
  ])

  assert.equal(getHistoricalUnitCost(ledgers, 23, 230, "2026-06-01"), 1000)
})

test("un producto cuya única compra está pendiente queda SIN costo conocido, nunca en 0", () => {
  const ledgers = buildProductCostLedgers([
    row({
      product_id: 24,
      variant_id: 240,
      quantity: 5,
      total_cost: 5000,
      reception_status: "pendiente",
      received_quantity: 0,
    }),
  ])
  const resolutions = resolveProductVariantCosts(
    ledgers,
    24,
    [{ id: 240, nombre: "ÚNICA" }],
    "2026-06-01",
  )

  assert.equal(resolutions[0].unitCost, null)
  assert.equal(getWorstCaseKnownCost(resolutions), null)
})

test("getReceivedCostContribution: una fila sin reception_status se trata como recibida", () => {
  const contribution = getReceivedCostContribution(
    row({ quantity: 2, total_cost: 500, reception_status: null, received_quantity: null }),
  )

  assert.deepEqual(contribution, { quantity: 2, cost: 500 })
})

// --- Filas corruptas/adversariales: la constraint de la tabla debería
// impedir esto en datos nuevos, pero el código no puede asumirlo para datos
// legacy o insertados por un camino que la eluda -- tiene que fallar cerrado
// (nunca inventar un costo negativo o mayor al real). ---

test("received_quantity NEGATIVO se recorta a 0, nunca resta cantidad al ledger", () => {
  const contribution = getReceivedCostContribution(
    row({ quantity: 10, total_cost: 1000, reception_status: "parcial", received_quantity: -5 }),
  )

  assert.equal(contribution, null)
})

test("received_quantity MAYOR a quantity se recorta a la compra completa, nunca a más", () => {
  const contribution = getReceivedCostContribution(
    row({ quantity: 5, total_cost: 500, reception_status: "parcial", received_quantity: 999 }),
  )

  assert.deepEqual(contribution, { quantity: 5, cost: 500 })
})

test("quantity 0 o negativa nunca aporta, sin importar el reception_status", () => {
  assert.equal(
    getReceivedCostContribution(row({ quantity: 0, total_cost: 0, reception_status: "recibida" })),
    null,
  )
  assert.equal(
    getReceivedCostContribution(
      row({ quantity: -3, total_cost: -300, reception_status: "recibida" }),
    ),
    null,
  )
})

test("CONFIRMACIÓN: total_cost no puede ser negativo por diseño -- todos sus componentes tienen CHECK >= 0 / > 0", () => {
  const schema = readFileSync("supabase/sql/080_business_costs.sql", "utf8")

  assert.match(schema, /quantity integer not null check \(quantity > 0\)/)
  assert.match(schema, /unit_cost numeric\(14, 2\) not null check \(unit_cost >= 0\)/)
  assert.match(schema, /freight_cost numeric\(14, 2\) not null default 0 check \(freight_cost >= 0\)/)
  assert.match(schema, /tax_cost numeric\(14, 2\) not null default 0 check \(tax_cost >= 0\)/)
  assert.match(
    schema,
    /commission_cost numeric\(14, 2\) not null default 0 check \(commission_cost >= 0\)/,
  )
  assert.match(schema, /other_cost numeric\(14, 2\) not null default 0 check \(other_cost >= 0\)/)
  assert.match(
    schema,
    /total_cost numeric\(14, 2\) generated always as \(\s*\n\s*quantity \* unit_cost \+ freight_cost \+ tax_cost \+ commission_cost \+ other_cost\s*\n\s*\) stored/,
  )
})

test("un total_cost negativo (imposible por las CHECK constraints de la tabla) igual queda bloqueado río abajo por calculatePriceFromTargetMargin, nunca produce un precio", () => {
  // total_cost es una columna GENERATED a partir de quantity/unit_cost/
  // freight_cost/tax_cost/commission_cost/other_cost, todos con CHECK >= 0
  // (o > 0 para quantity) en supabase/sql/080_business_costs.sql -- un
  // total_cost negativo es matemáticamente imposible en una fila real. Este
  // test documenta que, aunque igual llegara un valor corrupto, no se
  // "arregla" silenciosamente: el costo resultante queda <= 0 y
  // calculatePriceFromTargetMargin (lib/pricing/product-pricing.ts) lo
  // rechaza explícitamente en vez de calcular un precio con un costo inválido.
  const ledgers = buildProductCostLedgers([
    row({ product_id: 40, variant_id: 400, quantity: 1, total_cost: -1000 }),
  ])
  const unitCost = getHistoricalUnitCost(ledgers, 40, 400, "2026-06-01")

  assert.equal(unitCost, -1000)
  assert.ok(unitCost !== null && unitCost <= 0)
})

// --- Margen objetivo con variantes sin costo conocido (P1) ---

test("margen objetivo BLOQUEADO si una variante vendible no tiene costo conocido", () => {
  const ledgers = buildProductCostLedgers([
    row({ product_id: 30, variant_id: 300, quantity: 1, total_cost: 800 }),
  ])
  const basis = resolveTargetMarginCostBasis(
    resolveProductVariantCosts(
      ledgers,
      30,
      [
        { id: 300, nombre: "CON COSTO" },
        { id: 301, nombre: "SIN COSTO" },
      ],
      "2026-06-01",
    ),
  )

  assert.equal(basis.ok, false)
  if (basis.ok) return
  assert.equal(basis.reason, "missing_variant_cost")
  assert.deepEqual(
    basis.missing.map((entry) => entry.variantId),
    [301],
  )
  // Nunca cae al peor caso de las variantes conocidas: ese precio garantizaría
  // un margen que no existe en la variante sin costo.
  assert.match(getTargetMarginCostBasisError(basis), /variantes sin costo conocido/i)
  assert.match(getTargetMarginCostBasisError(basis), /SIN COSTO/)
})

test("margen objetivo permitido cuando TODAS las variantes vendibles tienen costo: usa el peor caso", () => {
  const ledgers = buildProductCostLedgers([
    row({ product_id: 31, variant_id: 310, quantity: 1, total_cost: 800 }),
    row({ product_id: 31, variant_id: 311, quantity: 1, total_cost: 1200 }),
  ])
  const basis = resolveTargetMarginCostBasis(
    resolveProductVariantCosts(
      ledgers,
      31,
      [
        { id: 310, nombre: "BARATA" },
        { id: 311, nombre: "CARA" },
      ],
      "2026-06-01",
    ),
  )

  assert.equal(basis.ok, true)
  if (!basis.ok) return
  assert.equal(basis.cost, 1200)
})

test("producto sin ningún costo: se distingue de 'falta el costo de una variante'", () => {
  const basis = resolveTargetMarginCostBasis(
    resolveProductVariantCosts(buildProductCostLedgers([]), 32, [], "2026-06-01"),
  )

  assert.equal(basis.ok, false)
  if (basis.ok) return
  assert.equal(basis.reason, "no_cost")
  assert.match(getTargetMarginCostBasisError(basis), /Costo desconocido/i)
})
