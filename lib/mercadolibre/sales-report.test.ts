import assert from "node:assert/strict"
import test from "node:test"

import { buildMercadoLibreWorkbook, saleRow } from "./fixtures/ml-report-fixture.ts"
import { getMercadoLibreCostableUnits } from "./sale-costing.ts"
import {
  describeMercadoLibreReturnedUnits,
  getMercadoLibreReturnEvidence,
  parseMercadoLibreDate,
  parseMercadoLibreSalesReport,
  summarizeMercadoLibreRows,
  type MercadoLibreImportRow,
} from "./sales-report.ts"

function stockRow(parsed: Partial<MercadoLibreImportRow["raw_data"]["parsed"]>) {
  const row: MercadoLibreImportRow = {
    sale_date: "2026-03-15T14:35:00-03:00",
    operation_id: "ML-1",
    order_id: "ML-1",
    product_name: "Producto",
    sku: "SKU-1",
    quantity: Number(parsed.units ?? 4),
    gross_amount: 100,
    fee_amount: 0,
    shipping_amount: 0,
    net_amount: 100,
    raw_data: {
      report_format: "mercadolibre_ventas_ar",
      parsed: parsed as MercadoLibreImportRow["raw_data"]["parsed"],
      grouped: {},
      source: { sheet: "Ventas AR", row_number: 2, groups: [], headers: [], cells: [] },
    },
  }
  return { ...row }
}

test("conserva la fecha efectiva de una venta histórica cargada después", () => {
  assert.equal(
    parseMercadoLibreDate("15 de marzo de 2026 14:35"),
    "2026-03-15T14:35:00-03:00",
  )
})

test("interpreta meses con tildes y rechaza fechas ambiguas", () => {
  assert.equal(
    parseMercadoLibreDate("1 de febrero de 2026"),
    "2026-02-01T00:00:00-03:00",
  )
  assert.equal(parseMercadoLibreDate("03/04/26"), null)
})

// El costeo de una línea importada usa la única regla centralizada
// (sale-costing.ts), la misma del Dashboard y la pantalla ML.
test("una venta ML costea sólo sus unidades efectivas", () => {
  assert.equal(
    getMercadoLibreCostableUnits(stockRow({ units: 4, status: "Entregada", return_units: 0 })),
    4,
  )
})

test("cancelaciones y devoluciones parciales no descuentan dos veces", () => {
  assert.equal(
    getMercadoLibreCostableUnits(stockRow({ units: 4, status: "Cancelada", return_units: 0 })),
    0,
  )
  assert.equal(
    getMercadoLibreCostableUnits(stockRow({ units: 4, status: "Devuelta parcialmente", return_units: 1 })),
    3,
  )
})

// F/G/H: "Unidades devueltas" vacía (null) ≠ 0 ≠ cantidad conocida, desde el
// archivo hasta el resumen; el COGS sólo se recupera con cantidad explícita.
test("unidades devueltas: vacía = desconocida, 0 = cero conocido, >0 = cantidad; el resumen no inventa un neto", () => {
  const devolucion = { status: "Devolución finalizada con reembolso al comprador", units: 2, cancellations_refunds: -20000, total: -4550 }
  const report = parseMercadoLibreSalesReport(buildMercadoLibreWorkbook([
    saleRow({ sale_number: "2000000000000101", ...devolucion }),
    saleRow({ sale_number: "2000000000000102", ...devolucion, return_units: 0 }),
    saleRow({ sale_number: "2000000000000103", ...devolucion, return_units: 1 }),
    saleRow({ sale_number: "2000000000000104", units: 2 }),
  ]), "ventas.xlsx")
  const [unknown, zero, known, delivered] = report.rows

  assert.equal(unknown.raw_data.parsed.return_units, null)
  assert.equal(zero.raw_data.parsed.return_units, 0)
  assert.equal(known.raw_data.parsed.return_units, 1)
  // El JSON que viaja y se guarda conserva null.
  assert.equal(JSON.parse(JSON.stringify(unknown.raw_data)).parsed.return_units, null)

  assert.deepEqual(
    report.rows.map((row) => getMercadoLibreReturnEvidence(row.raw_data.parsed).physicalReturnedUnits),
    [null, 0, 1, null],
  )
  assert.deepEqual(report.rows.map((row) => getMercadoLibreCostableUnits(row as unknown as Record<string, unknown>)), [2, 2, 1, 2])

  const summary = summarizeMercadoLibreRows(report.rows)
  assert.equal(summary.returnedUnits, 1, "sólo cuenta la cantidad informada")
  assert.equal(summary.unknownPhysicalReturnLines, 1, "la entrega sin devolución no cuenta como desconocida")
  assert.equal(describeMercadoLibreReturnedUnits(summary), "1 devueltas confirmadas · devoluciones físicas desconocidas en 1 línea")
  assert.doesNotMatch(describeMercadoLibreReturnedUnits(summary), /netas/)

  const allKnown = summarizeMercadoLibreRows([zero, known, delivered])
  assert.equal(allKnown.unknownPhysicalReturnLines, 0)
  assert.equal(describeMercadoLibreReturnedUnits(allKnown), "1 devueltas · 5 netas")
})

test("devolución con reembolso sin unidades devueltas informadas: física desconocida, COGS completo", () => {
  const parsed = {
    units: 2,
    status: "Devolución finalizada con reembolso al comprador",
    return_units: null,
    claim_closed: "1",
    product_revenue: 55_840,
    cancellations_refunds: -41_670,
    total: -16_570,
  }
  const evidence = getMercadoLibreReturnEvidence(parsed)
  assert.equal(evidence.isReturn, true)
  assert.equal(evidence.refundAmount, 41_670)
  assert.equal(evidence.physicalReturnedUnits, null, "el 1 de ‘Reclamo cerrado’ no son unidades devueltas")
  assert.notEqual(evidence.totalDifference, 0, "la discrepancia del Total ML queda visible")
  assert.equal(getMercadoLibreCostableUnits(stockRow(parsed)), 2)
})
