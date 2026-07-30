import assert from "node:assert/strict"
import test from "node:test"

import {
  getMercadoLibreSaleIdentity,
  validateMercadoLibreImportBatch,
  type MercadoLibreIdentityRow,
} from "./import-integrity"

function sale(
  overrides: Partial<MercadoLibreIdentityRow> = {},
): MercadoLibreIdentityRow {
  return {
    sale_date: "2026-07-29T12:00:00.000Z",
    operation_id: "200000000001",
    order_id: "200000000001",
    product_name: "Apoyabrazos ergonómico",
    sku: "AP01",
    quantity: 3,
    gross_amount: 84000,
    raw_data: {
      parsed: {
        listing_id: "MLA123",
        variant: "Negro",
        status: "Entregada",
      },
      source: { row_number: 8 },
    },
    ...overrides,
  }
}

test("la identidad no cambia por estado, cantidades financieras o archivo", () => {
  const original = sale()
  const updated = sale({
    quantity: 4,
    source_file_name: "reporte-nuevo.xlsx",
    raw_data: {
      parsed: {
        listing_id: "MLA123",
        variant: "Negro",
        status: "Devuelta",
      },
    },
  })

  assert.equal(
    getMercadoLibreSaleIdentity(original),
    getMercadoLibreSaleIdentity(updated),
  )
})

test("distingue publicaciones y variantes dentro de una misma orden", () => {
  const black = sale()
  const blue = sale({
    sku: "AP02",
    raw_data: {
      parsed: {
        listing_id: "MLA123",
        variant: "Azul",
        status: "Entregada",
      },
    },
  })
  const otherListing = sale({
    sku: "TRI360",
    raw_data: {
      parsed: {
        listing_id: "MLA999",
        variant: "",
        status: "Entregada",
      },
    },
  })

  assert.notEqual(
    getMercadoLibreSaleIdentity(black),
    getMercadoLibreSaleIdentity(blue),
  )
  assert.notEqual(
    getMercadoLibreSaleIdentity(black),
    getMercadoLibreSaleIdentity(otherListing),
  )
})

test("ignora filas idénticas del mismo archivo y rechaza contradicciones", () => {
  const first = sale()
  const repeated = sale({
    raw_data: {
      ...first.raw_data,
      source: { row_number: 99 },
    },
  })
  const validated = validateMercadoLibreImportBatch([first, repeated])

  assert.equal(validated.rows.length, 1)
  assert.equal(validated.duplicateRows, 1)
  assert.throws(
    () =>
      validateMercadoLibreImportBatch([
        first,
        sale({ quantity: 99 }),
      ]),
    /datos contradictorios/,
  )
})

test("dos millones de reimportaciones conservan una venta y el mismo stock", () => {
  const row = sale()
  const ledger = new Map<string, MercadoLibreIdentityRow>()

  for (let index = 0; index < 2_000_000; index += 1) {
    ledger.set(getMercadoLibreSaleIdentity(row), row)
  }

  const soldUnits = [...ledger.values()].reduce(
    (total, item) => total + Number(item.quantity ?? 0),
    0,
  )

  assert.equal(ledger.size, 1)
  assert.equal(soldUnits, 3)
  assert.equal(100 - soldUnits, 97)
})
