import assert from "node:assert/strict"
import test from "node:test"

import {
  describeMercadoLibreImportError,
  validateMercadoLibreServerRows,
} from "./import-validation.ts"

function serverRow(overrides: Record<string, unknown> = {}) {
  return {
    sale_date: "2026-10-01T23:50:00-03:00",
    operation_id: "2000012345678901",
    order_id: "",
    product_name: "  Auriculares Ñandú Pro ",
    sku: " AUR-01 ",
    quantity: 2,
    gross_amount: 20000,
    fee_amount: 2750,
    shipping_amount: 1800,
    net_amount: 15450,
    raw_data: { report_format: "mercadolibre_ventas_ar", parsed: { status: "Entregada" }, source: { row_number: 23 } },
    ...overrides,
  }
}

test("el servidor revalida cada fila y no confía en el análisis del navegador", () => {
  const ok = validateMercadoLibreServerRows([serverRow()])
  assert.ok(ok.ok)
  assert.equal(ok.rows[0].order_id, "2000012345678901", "sin orden de compra se usa el número de venta")
  assert.equal(ok.rows[0].product_name, "Auriculares Ñandú Pro")
  assert.equal(ok.rows[0].sku, "AUR-01")

  const error = (row: Record<string, unknown>) => {
    const result = validateMercadoLibreServerRows([serverRow(row)])
    return result.ok ? "ok" : result.error
  }
  assert.equal(error({ operation_id: "2E+15" }), "Fila 23: el número de venta no es válido.")
  assert.equal(error({ sale_date: "2026-10-01" }), "Fila 23: la fecha de venta no es válida.")
  assert.equal(error({ quantity: 0 }), "Fila 23: las unidades no son válidas.")
  assert.equal(error({ quantity: 1.5 }), "Fila 23: las unidades no son válidas.")
  assert.equal(error({ gross_amount: "20000" }), "Fila 23: algún importe no es un número válido.")
  assert.equal(error({ net_amount: Number.NaN }), "Fila 23: algún importe no es un número válido.")
  assert.equal(error({ gross_amount: 1e12 }), "Fila 23: un importe supera el máximo admitido.")
  assert.equal(error({ product_name: "   " }), "Fila 23: falta el nombre del producto o es demasiado largo.")
  assert.equal(error({ raw_data: { parsed: {} } }), "Registro 1: faltan los datos originales del reporte.", "sin fila de origen se informa la posición")
  assert.deepEqual(validateMercadoLibreServerRows([]), { ok: false, error: "No hay ventas para importar." })
  assert.equal(validateMercadoLibreServerRows(Array.from({ length: 501 }, () => serverRow())).ok, false)
})

test("los errores de base se traducen; nunca se muestra SQL al usuario", () => {
  assert.match(describeMercadoLibreImportError("STOCK_INSUFICIENTE: la importación dejaría stock negativo.", "x"), /stock negativo en productos vinculados/)
  assert.equal(
    describeMercadoLibreImportError("ML_IMPORT_INVALID_ROW: la fila 23 tiene unidades inválidas.", "x"),
    "La fila 23 tiene unidades inválidas. Este bloque no se guardó.",
  )
  assert.match(describeMercadoLibreImportError('function public.import_mercadolibre_sales_batch does not exist', "x"), /Falta aplicar la migración 20261015100000/)
  assert.equal(describeMercadoLibreImportError('duplicate key value violates unique constraint "x"', "Mensaje genérico."), "Mensaje genérico.")
  assert.equal(describeMercadoLibreImportError(null, "Mensaje genérico."), "Mensaje genérico.")
})
