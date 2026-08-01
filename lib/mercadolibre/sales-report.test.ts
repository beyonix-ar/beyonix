import assert from "node:assert/strict"
import test from "node:test"

import {
  getMercadoLibreCostableUnits,
  parseMercadoLibreDate,
  type MercadoLibreImportRow,
} from "./sales-report.ts"

function stockRow(
  parsed: Partial<MercadoLibreImportRow["raw_data"]["parsed"]>,
): MercadoLibreImportRow {
  return {
    sale_date: "2026-03-15T14:35:00-03:00",
    operation_id: "ML-1",
    order_id: "ML-1",
    product_name: "Producto",
    sku: "SKU-1",
    quantity: 4,
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

test("una venta ML descuenta sólo sus unidades efectivas", () => {
  assert.equal(
    getMercadoLibreCostableUnits(
      stockRow({ units: 4, status: "Entregada", return_units: 0 }),
    ),
    4,
  )
})

test("cancelaciones y devoluciones parciales no descuentan dos veces", () => {
  assert.equal(
    getMercadoLibreCostableUnits(
      stockRow({ units: 4, status: "Cancelada", return_units: 0 }),
    ),
    0,
  )
  assert.equal(
    getMercadoLibreCostableUnits(
      stockRow({ units: 4, status: "Devuelta parcialmente", return_units: 1 }),
    ),
    3,
  )
})
