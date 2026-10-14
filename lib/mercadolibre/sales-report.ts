import * as XLSX from "xlsx"

import { getMercadoLibreSaleIdentity } from "./import-integrity.ts"
import {
  MERCADOLIBRE_COLUMNS,
  MERCADOLIBRE_FIELD_KEYS,
  findHeaderRow,
  resolveMercadoLibreColumns,
  type MercadoLibreFieldKey,
} from "./report-columns.ts"
import {
  cleanText,
  foldText,
  normalizeListingId,
  normalizeOptionalText,
  parseAmount,
  parseArgentinaDateTime,
  parseSaleNumber,
  parseUnits,
} from "./report-values.ts"

export { MERCADOLIBRE_FIELD_KEYS, type MercadoLibreFieldKey }
export type MercadoLibreFieldMap = Record<MercadoLibreFieldKey, string | number | null>

export const MERCADOLIBRE_MAX_FILE_BYTES = 25 * 1024 * 1024
export const MERCADOLIBRE_MAX_ROWS = 20_000

export interface MercadoLibreImportRow {
  sale_date: string | null
  operation_id: string
  order_id: string
  product_name: string
  sku: string | null
  quantity: number
  gross_amount: number
  fee_amount: number
  shipping_amount: number
  net_amount: number
  raw_data: {
    report_format: "mercadolibre_ventas_ar"
    parsed: MercadoLibreFieldMap
    grouped: Record<string, Record<string, string | number | null>>
    beyonix_cost_mapping?: {
      product_id: number
      variant_id: number | null
      match_key: string
      mapped_at?: string
      mapped_by?: string
    }
    source: {
      sheet: string
      row_number: number
      /** Sólo en importaciones anteriores: hoy los encabezados viven en el lote. */
      groups?: string[]
      headers?: string[]
      cells: Array<string | number | null>
    }
  }
}

export interface MercadoLibreReportSummary {
  sales: number
  completedSales: number
  returnSales: number
  cancelledSales: number
  units: number
  returnedUnits: number
  cancelledUnits: number
  netUnits: number
  productRevenue: number
  saleFees: number
  salesWithSaleFee: number
  fixedCosts: number
  installmentCosts: number
  shippingIncome: number
  shippingIncomeOnReturns: number
  shippingIncomeOnEffectiveSales: number
  shippingCosts: number
  declaredShippingCosts: number
  sizeWeightDifferenceCharges: number
  taxes: number
  discountsBonuses: number
  cancellationsRefunds: number
  total: number
  returnShippingCosts: number
  claims: number
}

export type MercadoLibreFileKind = "xlsx" | "xls" | "csv"

export interface MercadoLibreInvalidRow {
  rowNumber: number
  saleNumber: string | null
  messages: string[]
}

export interface MercadoLibreDuplicateRow {
  rowNumber: number
  saleNumber: string
  duplicateOfRow: number
}

export interface MercadoLibreImportTotals {
  /** Operaciones distintas (una venta con varias líneas cuenta una vez). */
  operations: number
  lines: number
  units: number
  gross: number
  charges: number
  shipping: number
  refunds: number
  net: number
}

export interface ParsedMercadoLibreReport {
  fileKind: MercadoLibreFileKind
  sheetName: string
  headerRowNumber: number
  headers: string[]
  columns: Array<{ key: MercadoLibreFieldKey; label: string; header: string; column: number }>
  missingOptionalColumns: string[]
  usedLegacyLayout: boolean
  /** Filas con algún dato debajo del encabezado. */
  rowsRead: number
  emptyRows: number
  /** Líneas válidas y únicas, listas para importar. */
  rows: MercadoLibreImportRow[]
  invalidRows: MercadoLibreInvalidRow[]
  duplicateRows: MercadoLibreDuplicateRow[]
  packageRows: number
  totals: MercadoLibreImportTotals
  reconciliation: { checked: number; matching: number; matchingWithDeclaredShipping: number }
  summary: MercadoLibreReportSummary
  warnings: string[]
}

export class MercadoLibreReportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "MercadoLibreReportError"
  }
}

const NUMERIC_FIELDS = new Set<MercadoLibreFieldKey>([
  "product_revenue",
  "sale_fee",
  "fixed_cost",
  "installment_cost",
  "shipping_income",
  "shipping_cost",
  "declared_shipping_cost",
  "size_weight_difference_charge",
  "taxes",
  "discounts_bonuses",
  "cancellations_refunds",
  "total",
  "listing_unit_price",
  "return_money_in_favor",
])

const UNIT_FIELDS = new Set<MercadoLibreFieldKey>(["units", "return_units", "claim_units"])

type CellValue = string | number | boolean | null | { excelDate: number } | { formulaError: string }

function text(value: unknown) {
  return value == null ? "" : String(value).trim()
}

/** Lectura tolerante para valores ya validados y guardados. */
function number(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0
  const parsed = parseAmount(value)
  return parsed.ok ? parsed.value : 0
}

function rounded(value: number) {
  return Math.round(value * 100) / 100
}

export function parseMercadoLibreDate(value: unknown) {
  const parsed = parseArgentinaDateTime(value)
  return parsed.ok ? parsed.value : null
}

function folded(value: unknown) {
  return foldText(value)
}

function isReturnRow(fields: MercadoLibreFieldMap) {
  const status = folded(fields.status)
  if (isCancelledRow(fields)) return false
  return (
    status.includes("devol") ||
    status.includes("reembolso") ||
    number(fields.cancellations_refunds) < 0 ||
    Boolean(text(fields.return_tracking_number)) ||
    Boolean(text(fields.return_result))
  )
}

function isCancelledRow(fields: MercadoLibreFieldMap) {
  const status = folded(fields.status)
  return status.includes("cancel") || status.includes("anulad")
}

function isPackageRow(fields: MercadoLibreFieldMap) {
  const flag = folded(fields.multi_product_package)
  return flag === "si" || /^paquete de \d+ productos?/.test(folded(fields.status))
}

/**
 * Fórmulas monetarias de una línea de ML (los cargos vienen negativos en el
 * reporte):
 *  - bruto   = Ingresos por productos
 *  - cargos  = −(cargo por venta + costo fijo + cuotas + diferencia de peso + impuestos)
 *  - envío   = −(costos de envío + costo basado en medidas declaradas)
 *  - neto    = Total (lo que ML liquida; es la fuente de verdad del neto)
 *  - reembolso = |Anulaciones y reembolsos| cuando es negativo
 */
export function computeMercadoLibreAmounts(fields: Partial<MercadoLibreFieldMap>) {
  const gross = number(fields.product_revenue)
  const charges = -(
    number(fields.sale_fee) +
    number(fields.fixed_cost) +
    number(fields.installment_cost) +
    number(fields.size_weight_difference_charge) +
    number(fields.taxes)
  )
  const shipping = -number(fields.shipping_cost) - number(fields.declared_shipping_cost)
  const refunds = Math.abs(Math.min(number(fields.cancellations_refunds), 0))
  return {
    gross: rounded(gross),
    charges: rounded(charges),
    shipping: rounded(shipping),
    refunds: rounded(refunds),
    net: rounded(number(fields.total)),
  }
}

/**
 * Diferencia entre el "Total" informado por ML y la suma de sus conceptos.
 * Sirve para detectar columnas corridas o conceptos que el reporte agregó.
 */
export function getMercadoLibreTotalDifference(
  fields: Partial<MercadoLibreFieldMap>,
  includeDeclaredShipping: boolean,
) {
  const components =
    number(fields.product_revenue) +
    number(fields.sale_fee) +
    number(fields.fixed_cost) +
    number(fields.installment_cost) +
    number(fields.shipping_income) +
    number(fields.shipping_cost) +
    (includeDeclaredShipping ? number(fields.declared_shipping_cost) : 0) +
    number(fields.size_weight_difference_charge) +
    number(fields.taxes) +
    number(fields.discounts_bonuses) +
    number(fields.cancellations_refunds)
  return rounded(number(fields.total) - components)
}

export function getMercadoLibreCostableUnits(row: MercadoLibreImportRow) {
  const fields = row.raw_data.parsed
  const units = Math.max(0, Math.trunc(number(fields.units) || row.quantity || 0))
  if (isCancelledRow(fields)) return 0

  const reportedReturnedUnits = Math.max(0, Math.trunc(number(fields.return_units)))
  const returnedUnits = isReturnRow(fields) ? reportedReturnedUnits || units : reportedReturnedUnits

  return Math.max(0, units - Math.min(units, returnedUnits))
}

function createSummary(rows: MercadoLibreImportRow[]): MercadoLibreReportSummary {
  return rows.reduce<MercadoLibreReportSummary>(
    (summary, row) => {
      const fields = row.raw_data.parsed
      const returned = isReturnRow(fields)
      const cancelled = !returned && isCancelledRow(fields)
      const units = number(fields.units)
      const returnedUnits = returned
        ? Math.max(number(fields.return_units), units)
        : number(fields.return_units)

      summary.sales += 1
      summary.completedSales += returned || cancelled ? 0 : 1
      summary.returnSales += returned ? 1 : 0
      summary.cancelledSales += cancelled ? 1 : 0
      summary.units += units
      summary.returnedUnits += returnedUnits
      summary.cancelledUnits += cancelled ? units : 0
      summary.productRevenue += number(fields.product_revenue)
      summary.saleFees += number(fields.sale_fee)
      summary.salesWithSaleFee += number(fields.sale_fee) !== 0 ? 1 : 0
      summary.fixedCosts += number(fields.fixed_cost)
      summary.installmentCosts += number(fields.installment_cost)
      summary.shippingIncome += number(fields.shipping_income)
      summary.shippingIncomeOnReturns += returned ? number(fields.shipping_income) : 0
      summary.shippingIncomeOnEffectiveSales += returned || cancelled ? 0 : number(fields.shipping_income)
      summary.shippingCosts += number(fields.shipping_cost)
      summary.declaredShippingCosts += number(fields.declared_shipping_cost)
      summary.sizeWeightDifferenceCharges += number(fields.size_weight_difference_charge)
      summary.taxes += number(fields.taxes)
      summary.discountsBonuses += number(fields.discounts_bonuses)
      summary.cancellationsRefunds += number(fields.cancellations_refunds)
      summary.total += number(fields.total)
      summary.returnShippingCosts += returned
        ? Math.abs(number(fields.shipping_cost)) +
          Math.abs(number(fields.declared_shipping_cost)) +
          Math.abs(number(fields.size_weight_difference_charge))
        : 0
      const claimValues = [fields.claim_open, fields.claim_closed, fields.claim_mediation].map(folded)
      summary.claims +=
        number(fields.claim_units) > 0 || claimValues.some((value) => Boolean(value && value !== "no"))
          ? 1
          : 0
      summary.netUnits = Math.max(0, summary.units - summary.returnedUnits - summary.cancelledUnits)
      return summary
    },
    {
      sales: 0,
      completedSales: 0,
      returnSales: 0,
      cancelledSales: 0,
      units: 0,
      returnedUnits: 0,
      cancelledUnits: 0,
      netUnits: 0,
      productRevenue: 0,
      saleFees: 0,
      salesWithSaleFee: 0,
      fixedCosts: 0,
      installmentCosts: 0,
      shippingIncome: 0,
      shippingIncomeOnReturns: 0,
      shippingIncomeOnEffectiveSales: 0,
      shippingCosts: 0,
      declaredShippingCosts: 0,
      sizeWeightDifferenceCharges: 0,
      taxes: 0,
      discountsBonuses: 0,
      cancellationsRefunds: 0,
      total: 0,
      returnShippingCosts: 0,
      claims: 0,
    },
  )
}

export function summarizeMercadoLibreRows(rows: MercadoLibreImportRow[]) {
  return createSummary(rows)
}

export function computeMercadoLibreImportTotals(rows: MercadoLibreImportRow[]): MercadoLibreImportTotals {
  const operations = new Set<string>()
  const totals = rows.reduce(
    (current, row) => {
      const amounts = computeMercadoLibreAmounts(row.raw_data.parsed)
      operations.add(row.order_id || row.operation_id)
      current.units += number(row.raw_data.parsed.units)
      current.gross += amounts.gross
      current.charges += amounts.charges
      current.shipping += amounts.shipping
      current.refunds += amounts.refunds
      current.net += amounts.net
      return current
    },
    { units: 0, gross: 0, charges: 0, shipping: 0, refunds: 0, net: 0 },
  )
  return {
    operations: operations.size,
    lines: rows.length,
    units: totals.units,
    gross: rounded(totals.gross),
    charges: rounded(totals.charges),
    shipping: rounded(totals.shipping),
    refunds: rounded(totals.refunds),
    net: rounded(totals.net),
  }
}

/* ------------------------------------------------------------------ */
/* Lectura del archivo                                                 */
/* ------------------------------------------------------------------ */

function detectFileKind(bytes: Uint8Array, fileName?: string): MercadoLibreFileKind {
  if (bytes.length === 0) throw new MercadoLibreReportError("El archivo está vacío.")
  if (bytes.length > MERCADOLIBRE_MAX_FILE_BYTES) {
    throw new MercadoLibreReportError(
      "El archivo supera los 25 MB. Exportá un rango de fechas más corto desde Mercado Libre.",
    )
  }
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return "xlsx"
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) return "xls"

  const sample = bytes.subarray(0, Math.min(bytes.length, 4096))
  const binary = sample.some((byte) => byte === 0)
  if (binary || /\.(pdf|png|jpe?g|docx?|zip)$/i.test(fileName ?? "")) {
    throw new MercadoLibreReportError(
      "El archivo no es un Excel (.xlsx, .xls) ni un CSV. Descargá el reporte “Ventas” desde Mercado Libre.",
    )
  }
  return "csv"
}

function decodeText(bytes: Uint8Array) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "")
  } catch {
    // Excel en Windows guarda CSV en ANSI (windows-1252) por defecto.
    return new TextDecoder("windows-1252").decode(bytes)
  }
}

/** CSV con comillas (RFC 4180) y separador detectado: ";" (Excel AR), "," o tabulación. */
export function parseCsv(source: string): string[][] {
  const firstLine = source.split(/\r?\n/, 1)[0] ?? ""
  const delimiter = [";", "\t", ","]
    .map((candidate) => ({ candidate, count: firstLine.split(candidate).length - 1 }))
    .sort((left, right) => right.count - left.count)[0]
  const separator = delimiter && delimiter.count > 0 ? delimiter.candidate : ","

  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let quoted = false
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        field += char
      }
      continue
    }
    if (char === '"' && field === "") {
      quoted = true
    } else if (char === separator) {
      row.push(field)
      field = ""
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[index + 1] === "\n") index += 1
      row.push(field)
      rows.push(row)
      row = []
      field = ""
    } else {
      field += char
    }
  }
  if (field !== "" || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

/** Formato numérico de fecha/hora de Excel ("dd/mm/yyyy hh:mm", "m/d/yy", etc.). */
function isDateFormat(format: unknown) {
  if (typeof format !== "string" || /^general$/i.test(format)) return false
  const tokens = format.replace(/"[^"]*"|\[[^\]]*\]|\\./g, "")
  return /[dmyhs]/i.test(tokens) && !/[#?]/.test(tokens)
}

export function readSheetMatrix(sheet: XLSX.WorkSheet): CellValue[][] {
  const reference = sheet["!ref"]
  if (!reference) return []
  const range = XLSX.utils.decode_range(reference)
  const matrix: CellValue[][] = []
  for (let rowIndex = range.s.r; rowIndex <= range.e.r; rowIndex += 1) {
    const row: CellValue[] = []
    for (let columnIndex = range.s.c; columnIndex <= range.e.c; columnIndex += 1) {
      const cell = sheet[XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex })] as XLSX.CellObject | undefined
      if (!cell) {
        row.push(null)
      } else if (cell.t === "e") {
        row.push({ formulaError: text(cell.w) || "#ERROR" })
      } else if (cell.f && cell.v === undefined) {
        row.push({ formulaError: "fórmula sin resultado calculado" })
      } else if (cell.t === "n" && typeof cell.v === "number" && isDateFormat(cell.z)) {
        row.push({ excelDate: cell.v })
      } else if (cell.t === "d" && cell.v instanceof Date) {
        row.push(cell.v.toISOString())
      } else if (cell.t === "z" || cell.v === undefined) {
        row.push(null)
      } else {
        row.push(cell.v as string | number | boolean)
      }
    }
    matrix.push(row)
  }
  return matrix
}

function readWorkbook(buffer: ArrayBuffer, fileName?: string) {
  const bytes = new Uint8Array(buffer)
  const fileKind = detectFileKind(bytes, fileName)

  if (fileKind === "csv") {
    const rows = parseCsv(decodeText(bytes))
    return { fileKind, sheets: [{ name: "CSV", matrix: rows as CellValue[][] }] }
  }

  let workbook: XLSX.WorkBook
  try {
    workbook = XLSX.read(bytes, { type: "array", cellDates: false, cellNF: true, cellFormula: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : ""
    throw new MercadoLibreReportError(
      /password-protected/i.test(message)
        ? "El archivo está protegido con contraseña. Guardalo sin contraseña y volvé a cargarlo."
        : "El archivo está dañado o no se puede leer como Excel. Descargalo de nuevo desde Mercado Libre.",
    )
  }
  if (!workbook.SheetNames.length) throw new MercadoLibreReportError("El archivo no contiene hojas.")

  const ordered = [
    ...workbook.SheetNames.filter((name) => foldText(name) === "ventas ar"),
    ...workbook.SheetNames.filter((name) => foldText(name) !== "ventas ar"),
  ]
  return {
    fileKind,
    sheets: ordered.map((name) => ({ name, matrix: readSheetMatrix(workbook.Sheets[name]) })),
  }
}

function cellIsEmpty(value: CellValue) {
  return value == null || (typeof value === "string" && !cleanText(value))
}

function cellToRaw(value: CellValue): string | number | null {
  if (value == null) return null
  if (typeof value === "boolean") return value ? "Sí" : "No"
  if (typeof value === "object") {
    if ("excelDate" in value) return parseMercadoLibreDate(value.excelDate) ?? value.excelDate
    return `#ERROR: ${value.formulaError}`
  }
  return value
}

function cellForParsing(value: CellValue): unknown {
  if (value && typeof value === "object" && "excelDate" in value) return value.excelDate
  return value
}

/* ------------------------------------------------------------------ */
/* Análisis                                                            */
/* ------------------------------------------------------------------ */

function fieldFingerprint(row: MercadoLibreImportRow) {
  return JSON.stringify([
    row.sale_date,
    row.quantity,
    row.gross_amount,
    row.fee_amount,
    row.shipping_amount,
    row.net_amount,
    row.raw_data.parsed,
  ])
}

/**
 * Lee y valida un reporte de ventas de Mercado Libre sin modificar nada.
 * Las filas inválidas se informan y se excluyen; nunca se convierten en 0.
 */
export function parseMercadoLibreSalesReport(
  buffer: ArrayBuffer,
  fileName?: string,
): ParsedMercadoLibreReport {
  const { fileKind, sheets } = readWorkbook(buffer, fileName)

  const located = sheets
    .map((sheet) => ({ ...sheet, headerIndex: findHeaderRow(sheet.matrix) }))
    .find((sheet) => sheet.headerIndex >= 0)
  if (!located) {
    const hasData = sheets.some((sheet) => sheet.matrix.some((row) => row.some((cell) => !cellIsEmpty(cell))))
    throw new MercadoLibreReportError(
      hasData
        ? "El archivo no parece un reporte de ventas de Mercado Libre: no se encontraron las columnas ‘# de venta’ ni ‘Fecha de venta’."
        : "El archivo está vacío.",
    )
  }

  const { name: sheetName, matrix, headerIndex } = located
  const headerCells = matrix[headerIndex]
  const groupCells = headerIndex > 0 ? matrix[headerIndex - 1] : []
  const resolved = resolveMercadoLibreColumns(headerCells, groupCells)
  if (resolved.missingRequired.length) {
    const list = resolved.missingRequired.map((label) => `‘${label}’`)
    throw new MercadoLibreReportError(
      list.length === 1
        ? `No se encontró la columna ${list[0]}. Verificá que sea el reporte “Ventas” de Mercado Libre sin columnas eliminadas.`
        : `No se encontraron las columnas ${list.slice(0, -1).join(", ")} y ${list.at(-1)}. Verificá que sea el reporte “Ventas” de Mercado Libre sin columnas eliminadas.`,
    )
  }

  const headers = headerCells.map((cell) => cleanText(cellToRaw(cell)))
  const columns = MERCADOLIBRE_FIELD_KEYS.flatMap((key) => {
    const column = resolved.indexes[key]
    return column === undefined
      ? []
      : [{ key, label: MERCADOLIBRE_COLUMNS[key].label, header: headers[column] ?? "", column }]
  })
  const groupLabels: string[] = []
  let currentGroup = "Ventas"
  headers.forEach((_, index) => {
    const next = cleanText(cellToRaw(groupCells[index] ?? null))
    if (next) currentGroup = next
    groupLabels[index] = currentGroup
  })

  const dataRows = matrix.slice(headerIndex + 1)
  if (dataRows.length > MERCADOLIBRE_MAX_ROWS) {
    throw new MercadoLibreReportError(
      `El archivo tiene ${dataRows.length.toLocaleString("es-AR")} filas; el máximo por importación es ${MERCADOLIBRE_MAX_ROWS.toLocaleString("es-AR")}. Dividilo por fechas.`,
    )
  }

  let emptyRows = 0
  let rowsRead = 0
  let packageRows = 0
  const invalidRows: MercadoLibreInvalidRow[] = []
  const candidates: Array<{ row: MercadoLibreImportRow; rowNumber: number }> = []

  dataRows.forEach((cells, relativeIndex) => {
    const rowNumber = headerIndex + relativeIndex + 2
    if (cells.every(cellIsEmpty)) {
      emptyRows += 1
      return
    }
    rowsRead += 1
    const messages: string[] = []
    const cell = (key: MercadoLibreFieldKey): CellValue => {
      const column = resolved.indexes[key]
      return column === undefined ? null : (cells[column] ?? null)
    }
    const label = (key: MercadoLibreFieldKey) => MERCADOLIBRE_COLUMNS[key].label

    const fields = {} as MercadoLibreFieldMap
    for (const key of MERCADOLIBRE_FIELD_KEYS) {
      const value = cell(key)
      if (value && typeof value === "object" && "formulaError" in value) {
        messages.push(`‘${label(key)}’ tiene un error de fórmula (${value.formulaError})`)
        fields[key] = null
        continue
      }
      if (NUMERIC_FIELDS.has(key) || UNIT_FIELDS.has(key)) {
        const parsed = UNIT_FIELDS.has(key) ? parseUnits(cellForParsing(value)) : parseAmount(cellForParsing(value))
        if (parsed.ok) {
          fields[key] = parsed.value
        } else {
          messages.push(`‘${label(key)}’ ${parsed.reason} (“${cleanText(cellToRaw(value))}”)`)
          fields[key] = null
        }
        continue
      }
      if (key === "listing_id") {
        fields[key] = normalizeListingId(cellToRaw(value))
        continue
      }
      fields[key] = normalizeOptionalText(cellToRaw(value))
    }

    const saleNumber = parseSaleNumber(cell("sale_number"))
    if (saleNumber.ok) {
      fields.sale_number = saleNumber.value
    } else {
      messages.unshift(`el número de venta ${saleNumber.reason}`)
    }

    const saleDate = parseArgentinaDateTime(cellForParsing(cell("sale_date_text")))
    if (!saleDate.ok) messages.push(`la fecha de venta ${saleDate.reason}`)
    if (!text(fields.status)) messages.push("falta el estado de la venta")

    const units = fields.units
    if (typeof units === "number" && units < 1 && !isCancelledRow(fields)) {
      messages.push("tiene 0 unidades vendidas")
    }
    if (isPackageRow(fields)) packageRows += 1

    if (messages.length || !saleNumber.ok || !saleDate.ok) {
      invalidRows.push({
        rowNumber,
        saleNumber: saleNumber.ok ? saleNumber.value : normalizeOptionalText(cellToRaw(cell("sale_number"))),
        messages,
      })
      return
    }

    const purchaseOrder = parseSaleNumber(cell("purchase_order"))
    const amounts = computeMercadoLibreAmounts(fields)
    const grouped: MercadoLibreImportRow["raw_data"]["grouped"] = {}
    for (const column of columns) {
      const group = groupLabels[column.column] || "Ventas"
      grouped[group] ??= {}
      const display = column.header || column.label
      const uniqueLabel = grouped[group][display] === undefined ? display : `${display} (${column.key})`
      grouped[group][uniqueLabel] = fields[column.key]
    }

    candidates.push({
      rowNumber,
      row: {
        sale_date: saleDate.value,
        operation_id: saleNumber.value,
        order_id: purchaseOrder.ok ? purchaseOrder.value : saleNumber.value,
        product_name: text(fields.listing_title) || `Venta Mercado Libre ${saleNumber.value}`,
        sku: text(fields.sku) || null,
        quantity: Math.max(1, Math.trunc(number(fields.units))),
        gross_amount: amounts.gross,
        fee_amount: amounts.charges,
        shipping_amount: amounts.shipping,
        net_amount: amounts.net,
        raw_data: {
          report_format: "mercadolibre_ventas_ar",
          parsed: fields,
          grouped,
          source: {
            sheet: sheetName,
            row_number: rowNumber,
            cells: headers.map((_, index) => cellToRaw(cells[index] ?? null)),
          },
        },
      },
    })
  })

  // Duplicados dentro del archivo: idéntica = se ignora; misma venta con
  // datos distintos = no se puede decidir cuál vale, se rechazan todas.
  const byIdentity = new Map<string, Array<{ row: MercadoLibreImportRow; rowNumber: number }>>()
  for (const candidate of candidates) {
    const identity = getMercadoLibreSaleIdentity(candidate.row)
    byIdentity.set(identity, [...(byIdentity.get(identity) ?? []), candidate])
  }
  const rows: MercadoLibreImportRow[] = []
  const duplicateRows: MercadoLibreDuplicateRow[] = []
  for (const group of byIdentity.values()) {
    const [first, ...rest] = group
    const fingerprint = fieldFingerprint(first.row)
    if (rest.some((candidate) => fieldFingerprint(candidate.row) !== fingerprint)) {
      const rowNumbers = group.map((candidate) => candidate.rowNumber)
      for (const candidate of group) {
        invalidRows.push({
          rowNumber: candidate.rowNumber,
          saleNumber: candidate.row.operation_id,
          messages: [
            `la venta aparece repetida con datos distintos (filas ${rowNumbers.join(", ")}); corregí el archivo y volvé a cargarlo`,
          ],
        })
      }
      continue
    }
    rows.push(first.row)
    for (const candidate of rest) {
      duplicateRows.push({
        rowNumber: candidate.rowNumber,
        saleNumber: candidate.row.operation_id,
        duplicateOfRow: first.rowNumber,
      })
    }
  }
  rows.sort((left, right) => left.raw_data.source.row_number - right.raw_data.source.row_number)
  invalidRows.sort((left, right) => left.rowNumber - right.rowNumber)

  if (!rowsRead) throw new MercadoLibreReportError("El reporte no contiene ventas: sólo tiene encabezados.")

  let matching = 0
  let matchingWithDeclaredShipping = 0
  for (const row of rows) {
    if (Math.abs(getMercadoLibreTotalDifference(row.raw_data.parsed, false)) <= 1) matching += 1
    if (Math.abs(getMercadoLibreTotalDifference(row.raw_data.parsed, true)) <= 1) matchingWithDeclaredShipping += 1
  }

  const warnings: string[] = []
  if (resolved.usedLegacyLayout) {
    warnings.push("Algunas columnas se leyeron por su posición histórica porque su nombre no coincidió exactamente.")
  }
  if (packageRows) {
    warnings.push(
      `${packageRows} ${packageRows === 1 ? "fila pertenece" : "filas pertenecen"} a paquetes de varios productos. Cada línea se importa por separado; revisá que el paquete no repita importes.`,
    )
  }
  if (rows.length && Math.max(matching, matchingWithDeclaredShipping) < rows.length) {
    warnings.push(
      `En ${rows.length - Math.max(matching, matchingWithDeclaredShipping)} de ${rows.length} líneas el ‘Total’ de Mercado Libre no coincide con la suma de sus conceptos. Se usa el Total informado por ML como neto.`,
    )
  }

  return {
    fileKind,
    sheetName,
    headerRowNumber: headerIndex + 1,
    headers,
    columns,
    missingOptionalColumns: resolved.missingOptional,
    usedLegacyLayout: resolved.usedLegacyLayout,
    rowsRead,
    emptyRows,
    rows,
    invalidRows,
    duplicateRows,
    packageRows,
    totals: computeMercadoLibreImportTotals(rows),
    reconciliation: { checked: rows.length, matching, matchingWithDeclaredShipping },
    summary: createSummary(rows),
    warnings,
  }
}
