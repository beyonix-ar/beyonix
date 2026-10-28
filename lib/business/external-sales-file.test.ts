import assert from "node:assert/strict"
import test from "node:test"
import * as XLSX from "xlsx"

import { parseExternalSalesSheet } from "./external-sales"
import { excelSerialToIsoDate, readExternalSalesFile } from "./external-sales-file"

// Lectura real de .xlsx de ventas externas (xlsx + readSheetMatrix).

const TODAY = "2026-10-27"
const SERIAL_1900 = Date.UTC(2026, 2, 15) / 86_400_000 + 25569

function workbook(date1904: boolean) {
  const sheet = XLSX.utils.aoa_to_sheet([["Fecha", "SKU", "Cant.", "Precio Final"], [null, "AUR-1", 1, 15000.5]])
  // En el sistema 1904 el mismo día tiene un número de serie 1462 menor.
  sheet.A2 = { t: "n", v: date1904 ? SERIAL_1900 - 1462 : SERIAL_1900, z: "dd/mm/yyyy" }
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, sheet, "Ventas")
  book.Workbook = { WBProps: { date1904 } }
  return XLSX.write(book, { type: "array", bookType: "xlsx" }) as ArrayBuffer
}

test("Excel con sistema de fechas 1900 y 1904: la fecha se lee correcta, no corrida 4 años", () => {
  for (const date1904 of [false, true]) {
    const matrix = readExternalSalesFile(workbook(date1904), "ventas.xlsx")
    assert.equal(matrix[1][0], "2026-03-15", date1904 ? "sistema 1904" : "sistema 1900")
    assert.equal(matrix[1][3], "15000,50", "los números salen en formato argentino, sin ambigüedad")
    const [row] = parseExternalSalesSheet(matrix, TODAY).rows
    assert.equal(row.payload?.sale_date, "2026-03-15")
    assert.equal(row.payload?.gross_amount, 15000.5)
  }
})

test("una fecha de Excel imposible no se importa en silencio: el preview la marca inválida", () => {
  assert.equal(excelSerialToIsoDate(0), null)
  assert.equal(excelSerialToIsoDate(Number.NaN), null)
  const sheet = XLSX.utils.aoa_to_sheet([["Fecha", "SKU", "Cant.", "Precio Final"], [null, "AUR-1", 1, 100]])
  sheet.A2 = { t: "n", v: 0, z: "dd/mm/yyyy" }
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, sheet, "Ventas")
  const matrix = readExternalSalesFile(XLSX.write(book, { type: "array", bookType: "xlsx" }) as ArrayBuffer, "ventas.xlsx")
  const [row] = parseExternalSalesSheet(matrix, TODAY).rows
  assert.equal(row.payload, null)
  assert.match(row.errors.join(" "), /Fecha inválida/)
})
