import * as XLSX from "xlsx"

import {
  MERCADOLIBRE_COLUMNS,
  MERCADOLIBRE_FIELD_KEYS,
  type MercadoLibreFieldKey,
} from "../report-columns.ts"

/** Encabezado tal como lo escribe Mercado Libre (los repetidos se distinguen por grupo). */
const HEADER_TEXT: Partial<Record<MercadoLibreFieldKey, string>> = {
  return_units: "Unidades",
  return_method: "Forma de entrega",
  return_on_way_date: "Fecha en camino",
  return_delivered_date: "Fecha entregada",
  return_carrier: "Transportista",
  return_tracking_number: "Número de seguimiento",
  return_tracking_url: "URL de seguimiento",
  claim_units: "Unidades",
  buyer_state: "Estado",
}

const MONEY = new Set<MercadoLibreFieldKey>([
  "product_revenue", "sale_fee", "fixed_cost", "installment_cost", "shipping_income",
  "shipping_cost", "declared_shipping_cost", "size_weight_difference_charge", "taxes",
  "discounts_bonuses", "cancellations_refunds", "total", "listing_unit_price",
])

function groupOf(key: MercadoLibreFieldKey) {
  if (key.startsWith("billing_") || key === "tax_condition" || key === "gross_income_number") return "Facturación al comprador"
  if (key.startsWith("buyer") || key === "business") return "Compradores"
  if (key.startsWith("shipping_") && !["shipping_income", "shipping_cost"].includes(key)) return "Envíos"
  if (key.startsWith("return_")) return "Devoluciones"
  if (key.startsWith("claim_")) return "Reclamos"
  return "Ventas"
}

export function headerFor(key: MercadoLibreFieldKey) {
  const base = HEADER_TEXT[key] ?? MERCADOLIBRE_COLUMNS[key].label
  return MONEY.has(key) ? `${base} (ARS)` : base
}

export type FixtureRow = Partial<Record<MercadoLibreFieldKey, unknown>>

export function saleRow(overrides: FixtureRow = {}): FixtureRow {
  return {
    sale_number: "2000012345678901",
    sale_date_text: "15 de marzo de 2026 14:35 hs.",
    status: "Entregada",
    status_description: "Llegó el 18 de marzo",
    multi_product_package: "No",
    units: 2,
    product_revenue: 20000,
    sale_fee: -2600,
    fixed_cost: 0,
    installment_cost: 0,
    shipping_income: 0,
    shipping_cost: -1800,
    taxes: -150,
    cancellations_refunds: 0,
    total: 15450,
    sku: "AUR-01",
    listing_id: "MLA123456789",
    listing_title: "Auriculares Ñandú Pro",
    variant: "Color : Negro",
    listing_unit_price: 10000,
    buyer: "Lucía Güemes",
    buyer_state: "Córdoba",
    ...overrides,
  }
}

export interface FixtureOptions {
  /** Orden de columnas; por defecto el histórico de 65 columnas. */
  keys?: readonly MercadoLibreFieldKey[]
  /** Columnas extra (encabezado → valor por fila) insertadas antes de esa clave. */
  insertBefore?: { key: MercadoLibreFieldKey; header: string }
  groupRow?: boolean
  titleRows?: number
  sheetName?: string
  /** Celdas crudas por (fila de datos, clave) para fórmulas o fechas nativas. */
  rawCells?: Array<{ row: number; key: MercadoLibreFieldKey; cell: XLSX.CellObject }>
  /** Filas totalmente vacías intercaladas después de esa fila de datos. */
  blankAfter?: number[]
  bookType?: "xlsx" | "xls"
  /** Encabezados con otro texto (simula que ML renombró una columna). */
  renameHeaders?: Partial<Record<MercadoLibreFieldKey, string>>
}

export function buildMercadoLibreWorkbook(rows: FixtureRow[], options: FixtureOptions = {}) {
  const keys = [...(options.keys ?? MERCADOLIBRE_FIELD_KEYS)] as Array<MercadoLibreFieldKey | "__extra">
  if (options.insertBefore) keys.splice(keys.indexOf(options.insertBefore.key), 0, "__extra")
  const header = keys.map((key) => (key === "__extra" ? options.insertBefore!.header : (options.renameHeaders?.[key] ?? headerFor(key))))
  const groups = keys.map((key, index) => {
    const group = key === "__extra" ? "Ventas" : groupOf(key)
    const previous = index > 0 ? keys[index - 1] : null
    const previousGroup = previous ? (previous === "__extra" ? "Ventas" : groupOf(previous)) : null
    return group === previousGroup ? null : group
  })

  const matrix: unknown[][] = []
  for (let index = 0; index < (options.titleRows ?? 4); index += 1) {
    matrix.push(index === 0 ? ["Ventas | Mercado Libre"] : [])
  }
  if (options.groupRow !== false) matrix.push(groups)
  matrix.push(header)
  const firstDataRow = matrix.length
  rows.forEach((row, index) => {
    matrix.push(keys.map((key) => (key === "__extra" ? "extra" : (row[key] ?? null))))
    if (options.blankAfter?.includes(index)) matrix.push([])
  })

  const sheet = XLSX.utils.aoa_to_sheet(matrix)
  for (const raw of options.rawCells ?? []) {
    const column = keys.indexOf(raw.key)
    const address = XLSX.utils.encode_cell({ r: firstDataRow + raw.row, c: column })
    sheet[address] = raw.cell
  }
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, sheet, options.sheetName ?? "Ventas AR")
  const output = XLSX.write(workbook, { type: "array", bookType: options.bookType ?? "xlsx" }) as ArrayBuffer
  return output
}

export function textBuffer(source: string, encoding: "utf-8" | "latin1" = "utf-8") {
  const bytes = encoding === "utf-8" ? new TextEncoder().encode(source) : Uint8Array.from(source, (char) => char.charCodeAt(0))
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}
