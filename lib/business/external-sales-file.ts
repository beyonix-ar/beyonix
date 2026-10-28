import * as XLSX from "xlsx"

import { parseCsv, readSheetMatrix } from "@/lib/mercadolibre/sales-report"

// Lectura de un archivo de ventas externas (XLSX, XLS o CSV) a la misma
// matriz de texto que produce el pegado desde Excel. Se carga con import()
// sólo al elegir un archivo, para no sumar xlsx al panel.

export const EXTERNAL_SALES_MAX_FILE_BYTES = 10 * 1024 * 1024

export class ExternalSalesFileError extends Error {}

type SheetCell = ReturnType<typeof readSheetMatrix>[number][number]

// Días entre el origen de cada sistema de fechas de Excel y 1970-01-01. Los
// libros con "sistema de fechas 1904" (Excel para Mac antiguo) cuentan desde
// 1904-01-01: leerlos con el origen de 1900 corre todas las fechas 4 años.
const EXCEL_EPOCH_OFFSET_DAYS = { 1900: 25569, 1904: 24107 } as const

export function excelSerialToIsoDate(serial: number, date1904 = false) {
  if (!Number.isFinite(serial) || serial < 1) return null
  const days = serial - EXCEL_EPOCH_OFFSET_DAYS[date1904 ? 1904 : 1900]
  return new Date(Math.round(days * 86_400_000)).toISOString().slice(0, 10)
}

function cellText(cell: SheetCell, date1904: boolean): string {
  if (cell == null) return ""
  if (typeof cell === "boolean") return cell ? "Sí" : "No"
  if (typeof cell === "number") {
    // Formato argentino sin separador de miles: nunca ambiguo para el parser.
    return Number.isInteger(cell) ? String(cell) : cell.toFixed(2).replace(".", ",")
  }
  if (typeof cell === "object") {
    // Una fecha que no se puede convertir queda como texto inválido para que
    // el preview la marque como error en vez de importarla corrida.
    if ("excelDate" in cell) return excelSerialToIsoDate(cell.excelDate, date1904) ?? `Fecha de Excel ${cell.excelDate}`
    return "#ERROR"
  }
  return cell
}

function decodeText(bytes: Uint8Array) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    // Excel en Windows guarda CSV en ANSI (windows-1252) por defecto.
    return new TextDecoder("windows-1252").decode(bytes)
  }
}

export function readExternalSalesFile(buffer: ArrayBuffer, fileName: string): string[][] {
  const bytes = new Uint8Array(buffer)
  if (!bytes.length) throw new ExternalSalesFileError("El archivo está vacío.")
  if (bytes.length > EXTERNAL_SALES_MAX_FILE_BYTES) {
    throw new ExternalSalesFileError("El archivo supera los 10 MB. Dividí las ventas en varias tandas.")
  }

  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b
  const isLegacyExcel = bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0
  if (!isZip && !isLegacyExcel) {
    if (!/\.csv$/i.test(fileName) || bytes.subarray(0, 4096).some((byte) => byte === 0)) {
      throw new ExternalSalesFileError("Formato no admitido. Cargá un Excel (.xlsx, .xls) o un CSV.")
    }
    return parseCsv(decodeText(bytes).replace(/^﻿/, ""))
  }

  let workbook: XLSX.WorkBook
  try {
    workbook = XLSX.read(bytes, { type: "array", cellDates: false, cellNF: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : ""
    throw new ExternalSalesFileError(
      /password-protected/i.test(message)
        ? "El archivo está protegido con contraseña. Guardalo sin contraseña y volvé a cargarlo."
        : "El archivo está dañado o no se puede leer como Excel.",
    )
  }
  const sheetName = workbook.SheetNames[0]
  if (!sheetName) throw new ExternalSalesFileError("El archivo no contiene hojas.")
  const date1904 = workbook.Workbook?.WBProps?.date1904 === true
  return readSheetMatrix(workbook.Sheets[sheetName]).map((row) => row.map((cell) => cellText(cell, date1904)))
}
