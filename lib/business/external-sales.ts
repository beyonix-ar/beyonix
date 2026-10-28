// Ventas externas: contrato compartido entre UI, API y base (ver
// supabase/migrations/20261027210000_external_sales_imports_and_lifecycle.sql).
// Todo es puro: el parser de filas pegadas desde Excel, la normalización de
// canal/medio de pago/estado y la clasificación del preview no escriben nada.

export const EXTERNAL_SALE_CHANNELS = ["whatsapp", "instagram", "direct", "other"] as const
export type ExternalSaleChannel = (typeof EXTERNAL_SALE_CHANNELS)[number]
export const EXTERNAL_SALE_CHANNEL_LABELS: Record<ExternalSaleChannel, string> = {
  whatsapp: "WhatsApp",
  instagram: "Instagram",
  direct: "Venta directa",
  other: "Otro",
}

export const EXTERNAL_SALE_PAYMENT_METHODS = ["transfer", "cash", "mercadopago", "mercadopago_qr", "card", "other"] as const
export type ExternalSalePaymentMethod = (typeof EXTERNAL_SALE_PAYMENT_METHODS)[number]
export const EXTERNAL_SALE_PAYMENT_LABELS: Record<ExternalSalePaymentMethod, string> = {
  transfer: "Transferencia",
  cash: "Efectivo",
  mercadopago: "Mercado Pago",
  mercadopago_qr: "Mercado Pago QR",
  card: "Tarjeta",
  other: "Otro",
}

export type ExternalSaleStatus = "completed" | "delivered" | "reversed"
export type ExternalSaleActiveStatus = Exclude<ExternalSaleStatus, "reversed">
export const EXTERNAL_SALE_STATUS_LABELS: Record<ExternalSaleStatus, string> = {
  completed: "Confirmada",
  delivered: "Entregada",
  reversed: "Anulada",
}

export type ExternalSaleStockEffect = "none" | "consume"
export const EXTERNAL_SALE_STOCK_EFFECT_LABELS: Record<ExternalSaleStockEffect, string> = {
  none: "Histórica",
  consume: "Nueva",
}

export type ExternalSaleOrigin = "manual" | "paste" | "file"
export const EXTERNAL_SALE_ORIGIN_LABELS: Record<ExternalSaleOrigin, string> = {
  manual: "Carga manual",
  paste: "Filas pegadas",
  file: "Archivo importado",
}

export type ExternalSaleReversalKind = "entry_error" | "return" | "batch_undo"
export const EXTERNAL_SALE_REVERSAL_LABELS: Record<ExternalSaleReversalKind, string> = {
  entry_error: "Cargada por error",
  return: "Devolución",
  batch_undo: "Tanda deshecha",
}

export type ExternalSaleReturnCondition = "sellable" | "damaged"
export const EXTERNAL_SALE_RETURN_CONDITION_LABELS: Record<ExternalSaleReturnCondition, string> = {
  sellable: "Volvió en condición vendible",
  damaged: "Volvió dañado / no vendible",
}

export const EXTERNAL_SALE_IMPORT_MAX_ROWS = 2000

export interface ExternalSale {
  id: string
  sale_number: number
  sale_date: string
  product_id: number | null
  variant_id: number | null
  product_name: string
  sku: string | null
  quantity: number
  unit_price: number
  unit_cost: number
  gross_amount: number
  fee_amount: number
  shipping_amount: number
  other_expense_amount: number
  net_amount: number
  payment_method: string | null
  payment_method_code: ExternalSalePaymentMethod | null
  customer_name: string | null
  channel: ExternalSaleChannel | null
  channel_label: string | null
  notes: string | null
  reference: string | null
  status: ExternalSaleStatus
  stock_effect: ExternalSaleStockEffect
  origin: ExternalSaleOrigin
  import_batch_id: string | null
  source_row_number: number | null
  declared_profit: number | null
  costo_unitario_historico: number | null
  version: number
  modified_after_import_at: string | null
  reversal_kind: ExternalSaleReversalKind | null
  return_condition: ExternalSaleReturnCondition | null
  reversal_reason: string | null
  reversal_amount: number | null
  reversed_at: string | null
  reversed_by: string | null
  created_at: string
  updated_at: string
}

export interface ExternalSaleImportBatch {
  id: string
  created_at: string
  created_by: string | null
  created_by_name: string | null
  source: "paste" | "file"
  file_name: string | null
  stock_mode: ExternalSaleStockEffect
  rows_read: number
  rows_valid: number
  rows_imported: number
  status: "completed" | "reverted"
  reverted_at: string | null
  reverted_by_name: string | null
  revert_reason: string | null
  modified_sales: number
}

/** Fila de importación tal como la recibe la API y la RPC (columnas de external_sales). */
export interface ExternalSaleImportRowPayload {
  source_row_number: number
  sale_date: string
  customer_name: string | null
  channel: ExternalSaleChannel
  channel_label: string | null
  sku: string
  product_name: string | null
  quantity: number
  shipping_amount: number
  payment_method: string | null
  payment_method_code: ExternalSalePaymentMethod | null
  status: ExternalSaleActiveStatus
  gross_amount: number
  declared_profit: number | null
  notes: string | null
  source_values: Record<string, string> | null
  confirm_duplicate?: boolean
}

// ---------------------------------------------------------------------------
// Normalización de texto humano
// ---------------------------------------------------------------------------

export function foldText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

function cleanCell(value: string | null | undefined) {
  return (value ?? "").replace(/\s+/g, " ").trim()
}

export type ChannelResolution =
  | { code: ExternalSaleChannel; recognized: boolean }
  | { code: null; forbidden: "mercadolibre" | "web" }

export function normalizeExternalSaleChannel(text: string): ChannelResolution {
  const folded = foldText(text)
  if (!folded) return { code: "other", recognized: true }
  if (/^(ml|meli)$|mercado ?libre/.test(folded)) return { code: null, forbidden: "mercadolibre" }
  if (/^(web|tienda|tienda online|pagina|sitio|beyonix|beyonix web|tienda web)$/.test(folded)) {
    return { code: null, forbidden: "web" }
  }
  if (/whats ?app|^(wsp|wpp|wa|whatsapp)$/.test(folded)) return { code: "whatsapp", recognized: true }
  if (/instagram|^(ig|insta)$/.test(folded)) return { code: "instagram", recognized: true }
  if (/directa|directo|local|presencial|mostrador|en persona|personal/.test(folded)) {
    return { code: "direct", recognized: true }
  }
  if (folded === "otro" || folded === "otros") return { code: "other", recognized: true }
  return { code: "other", recognized: false }
}

export function normalizeExternalSalePaymentMethod(text: string): { code: ExternalSalePaymentMethod | null; recognized: boolean } {
  const folded = foldText(text)
  if (!folded) return { code: null, recognized: true }
  if (/\bqr\b/.test(folded)) return { code: "mercadopago_qr", recognized: true }
  if (/mercado ?pago|^mp$/.test(folded)) return { code: "mercadopago", recognized: true }
  if (/transf/.test(folded)) return { code: "transfer", recognized: true }
  if (/efectivo|^cash$|contado/.test(folded)) return { code: "cash", recognized: true }
  if (/tarjeta|debito|credito|visa|master|amex|naranja|cabal/.test(folded)) return { code: "card", recognized: true }
  if (folded === "otro" || folded === "otros") return { code: "other", recognized: true }
  return { code: "other", recognized: false }
}

export function normalizeExternalSaleStatus(text: string): { code: ExternalSaleStatus; recognized: boolean } {
  const folded = foldText(text)
  if (!folded || /^(confirmad[oa]|pagad[oa]|vendid[oa]|completad[oa]|ok|cobrad[oa])$/.test(folded)) {
    return { code: "completed", recognized: true }
  }
  if (/^entregad[oa]$/.test(folded)) return { code: "delivered", recognized: true }
  if (/anulad|cancelad|devuelt|devolucion/.test(folded)) return { code: "reversed", recognized: true }
  return { code: "completed", recognized: false }
}

/**
 * Importe en formato argentino o de planilla: "$ 12.345,67", "12345.67",
 * "-1.500", "(1.500)". Devuelve null si la celda está vacía y NaN si no es un número.
 */
export function parseExternalSaleAmount(text: string): number | null {
  let value = cleanCell(text).replace(/ars|\$/gi, "").replace(/\s+/g, "")
  if (!value) return null
  let negative = false
  if (/^\(.*\)$/.test(value)) {
    negative = true
    value = value.slice(1, -1)
  }
  if (value.startsWith("-")) {
    negative = !negative
    value = value.slice(1)
  }
  if (!/^[\d.,]+$/.test(value) || !/\d/.test(value)) return Number.NaN
  const lastComma = value.lastIndexOf(",")
  const lastDot = value.lastIndexOf(".")
  let normalized: string
  if (lastComma >= 0 && lastDot >= 0) {
    const grouped = lastComma > lastDot ? /^\d{1,3}(\.\d{3})*,\d+$/ : /^\d{1,3}(,\d{3})*\.\d+$/
    if (!grouped.test(value)) return Number.NaN
    normalized = lastComma > lastDot
      ? value.replace(/\./g, "").replace(",", ".")
      : value.replace(/,/g, "")
  } else if (lastComma >= 0) {
    normalized = /^\d{1,3}(,\d{3})+$/.test(value) && value.split(",").length > 2
      ? value.replace(/,/g, "")
      : value.replace(",", ".")
  } else if (/^\d{1,3}(\.\d{3})+$/.test(value)) {
    normalized = value.replace(/\./g, "")
  } else {
    normalized = value
  }
  if ((normalized.match(/\./g) ?? []).length > 1) return Number.NaN
  const parsed = Number(normalized)
  if (!Number.isFinite(parsed)) return Number.NaN
  return Math.round((negative ? -parsed : parsed) * 100) / 100
}

function isoDate(year: number, month: number, day: number) {
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
  return date.toISOString().slice(0, 10)
}

/** Fecha de planilla argentina (dd/mm/aaaa, d-m-aa) o ISO (aaaa-mm-dd), con hora opcional. */
export function parseExternalSaleDate(text: string): string | null {
  const value = cleanCell(text).split(/[ T]/)[0]
  if (!value) return null
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value)
  if (iso) return isoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]))
  const local = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(value)
  if (!local) return null
  const year = local[3].length === 2 ? 2000 + Number(local[3]) : Number(local[3])
  return isoDate(year, Number(local[2]), Number(local[1]))
}

/** Fecha de hoy en Argentina (la base valida lo mismo con America/Argentina/Buenos_Aires). */
export function argentinaToday(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now)
}

// ---------------------------------------------------------------------------
// Filas pegadas desde Excel
// ---------------------------------------------------------------------------

export type ExternalSaleImportField =
  | "sale_date" | "customer_name" | "channel" | "sku" | "product_name" | "quantity" | "cost"
  | "shipping_amount" | "total" | "payment_method" | "status" | "final_price" | "profit" | "notes"

/** Orden de las 14 columnas del Excel actual de ventas externas. */
export const EXTERNAL_SALE_EXCEL_COLUMNS: Array<{ field: ExternalSaleImportField; header: string }> = [
  { field: "sale_date", header: "Fecha" },
  { field: "customer_name", header: "Cliente" },
  { field: "channel", header: "Canal" },
  { field: "sku", header: "SKU" },
  { field: "product_name", header: "Producto" },
  { field: "quantity", header: "Cant." },
  { field: "cost", header: "Costo" },
  { field: "shipping_amount", header: "Envío" },
  { field: "total", header: "Total" },
  { field: "payment_method", header: "Medio de pago" },
  { field: "status", header: "Estado" },
  { field: "final_price", header: "Precio Final" },
  { field: "profit", header: "Ganancia" },
  { field: "notes", header: "Observación" },
]

const HEADER_ALIASES: Record<ExternalSaleImportField, string[]> = {
  sale_date: ["fecha", "fecha de venta", "fecha venta", "dia"],
  customer_name: ["cliente", "comprador", "nombre", "nombre cliente"],
  channel: ["canal", "canal de venta", "origen"],
  sku: ["sku", "codigo", "cod", "codigo sku"],
  product_name: ["producto", "articulo", "descripcion", "detalle"],
  quantity: ["cant", "cantidad", "unidades", "uds", "u"],
  cost: ["costo", "costo unitario", "costo producto"],
  shipping_amount: ["envio", "costo envio", "costo de envio", "envio pagado"],
  total: ["total"],
  payment_method: ["medio de pago", "medio pago", "forma de pago", "metodo de pago", "pago"],
  status: ["estado"],
  final_price: ["precio final", "precio", "importe", "monto", "cobrado", "precio venta"],
  profit: ["ganancia", "ganancia neta", "utilidad"],
  notes: ["observacion", "observaciones", "notas", "nota", "comentario", "comentarios"],
}

const REQUIRED_FIELDS: ExternalSaleImportField[] = ["sale_date", "sku", "quantity", "final_price"]
const FIELD_LABELS: Record<ExternalSaleImportField, string> = Object.fromEntries(
  EXTERNAL_SALE_EXCEL_COLUMNS.map((column) => [column.field, column.header]),
) as Record<ExternalSaleImportField, string>

function headerField(cell: string): ExternalSaleImportField | null {
  const folded = foldText(cell)
  if (!folded) return null
  for (const [field, aliases] of Object.entries(HEADER_ALIASES) as Array<[ExternalSaleImportField, string[]]>) {
    if (aliases.includes(folded)) return field
  }
  return null
}

/** Separa texto pegado desde Excel/Sheets (TSV, con celdas entre comillas si tienen saltos de línea). */
export function parseTabularText(source: string): string[][] {
  const text = source.replace(/^﻿/, "")
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
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
    } else if (char === "\t") {
      row.push(field)
      field = ""
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1
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

export interface ParsedExternalSaleRow {
  /** Número de fila en la hoja pegada/importada (1 = primera fila, normalmente encabezados). */
  sourceRowNumber: number
  payload: ExternalSaleImportRowPayload | null
  sourceValues: Record<string, string>
  errors: string[]
  warnings: string[]
  /** Misma regla que external_sale_content_hash en la base. */
  duplicateKey: string | null
}

export interface ParsedExternalSalesSheet {
  rows: ParsedExternalSaleRow[]
  headers: string[]
  headerDetected: boolean
  error: string | null
}

export function externalSaleDuplicateKey(input: {
  sale_date: string
  sku: string | null
  customer_name: string | null
  quantity: number
  gross_amount: number
}) {
  return [
    input.sale_date,
    (input.sku ?? "").trim().toUpperCase(),
    (input.customer_name ?? "").trim().replace(/\s+/g, " ").toLowerCase(),
    String(input.quantity),
    input.gross_amount.toFixed(2),
  ].join("\u001f")
}

function locateHeader(matrix: string[][]) {
  for (let index = 0; index < Math.min(matrix.length, 10); index += 1) {
    const fields = matrix[index].map((cell) => headerField(cell))
    const recognized = new Set(fields.filter((field): field is ExternalSaleImportField => field !== null))
    if (recognized.size >= 3 && (recognized.has("sale_date") || recognized.has("sku"))) {
      return { index, fields, headers: matrix[index].map((cell, column) => cleanCell(cell) || `Columna ${column + 1}`) }
    }
  }
  return null
}

/**
 * Interpreta una hoja (filas pegadas o archivo). Las filas con errores se
 * informan y nunca se convierten en ceros: el preview las excluye.
 */
export function parseExternalSalesSheet(matrix: string[][], today = argentinaToday()): ParsedExternalSalesSheet {
  const nonEmpty = matrix.some((row) => row.some((cell) => cleanCell(cell)))
  if (!nonEmpty) return { rows: [], headers: [], headerDetected: false, error: "No hay filas para interpretar." }

  const located = locateHeader(matrix)
  let fields: Array<ExternalSaleImportField | null>
  let headers: string[]
  let dataStart: number
  if (located) {
    fields = located.fields
    headers = located.headers
    dataStart = located.index + 1
    const duplicated = fields.filter((field, index) => field && fields.indexOf(field) !== index)
    if (duplicated.length) {
      return {
        rows: [], headers, headerDetected: true,
        error: `La columna ${FIELD_LABELS[duplicated[0] as ExternalSaleImportField]} aparece dos veces en los encabezados.`,
      }
    }
  } else {
    const width = Math.max(...matrix.map((row) => row.length))
    if (width !== EXTERNAL_SALE_EXCEL_COLUMNS.length) {
      return {
        rows: [], headers: [], headerDetected: false,
        error: "No se encontraron los encabezados. Copiá también la fila de títulos (Fecha, SKU, Cant., Precio Final…).",
      }
    }
    fields = EXTERNAL_SALE_EXCEL_COLUMNS.map((column) => column.field)
    headers = EXTERNAL_SALE_EXCEL_COLUMNS.map((column) => column.header)
    dataStart = 0
  }
  const missing = REQUIRED_FIELDS.filter((field) => !fields.includes(field))
  if (missing.length) {
    return {
      rows: [], headers, headerDetected: Boolean(located),
      error: `Faltan columnas obligatorias: ${missing.map((field) => FIELD_LABELS[field]).join(", ")}.`,
    }
  }

  const rows: ParsedExternalSaleRow[] = []
  for (let index = dataStart; index < matrix.length; index += 1) {
    const cells = matrix[index]
    if (!cells.some((cell) => cleanCell(cell))) continue
    const value = (field: ExternalSaleImportField) => {
      const column = fields.indexOf(field)
      return column >= 0 ? cleanCell(cells[column]) : ""
    }
    const sourceValues: Record<string, string> = {}
    headers.forEach((header, column) => {
      const cell = cleanCell(cells[column])
      if (cell || fields[column]) sourceValues[header] = cell.slice(0, 500)
    })
    rows.push(parseRow(index + 1, value, sourceValues, today))
  }
  if (!rows.length) return { rows, headers, headerDetected: Boolean(located), error: "No hay ventas debajo de los encabezados." }
  return { rows, headers, headerDetected: Boolean(located), error: null }
}

function parseRow(
  sourceRowNumber: number,
  value: (field: ExternalSaleImportField) => string,
  sourceValues: Record<string, string>,
  today: string,
): ParsedExternalSaleRow {
  const errors: string[] = []
  const warnings: string[] = []

  const rawDate = value("sale_date")
  const saleDate = parseExternalSaleDate(rawDate)
  if (!rawDate) errors.push("Falta la fecha.")
  else if (!saleDate) errors.push(`Fecha inválida: “${rawDate}”.`)
  else if (saleDate > today) errors.push("La fecha es futura.")
  else if (saleDate < "2000-01-01") errors.push("La fecha es anterior al año 2000.")

  const sku = value("sku")
  if (!sku) errors.push("Falta el SKU.")
  else if (sku.length > 120) errors.push("El SKU es demasiado largo.")

  const rawQuantity = value("quantity")
  const quantity = parseExternalSaleAmount(rawQuantity)
  if (quantity == null) errors.push("Falta la cantidad.")
  else if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100000) errors.push(`Cantidad inválida: “${rawQuantity}”.`)

  const rawPrice = value("final_price")
  const finalPrice = parseExternalSaleAmount(rawPrice)
  if (finalPrice == null) errors.push("Falta el precio final.")
  else if (Number.isNaN(finalPrice) || finalPrice < 0) errors.push(`Precio final inválido: “${rawPrice}”.`)

  const rawShipping = value("shipping_amount")
  const shipping = parseExternalSaleAmount(rawShipping)
  if (shipping != null && (Number.isNaN(shipping) || shipping < 0)) errors.push(`Envío inválido: “${rawShipping}”.`)

  const rawProfit = value("profit")
  const profit = parseExternalSaleAmount(rawProfit)
  if (profit != null && Number.isNaN(profit)) errors.push(`Ganancia inválida: “${rawProfit}”.`)

  const channelText = value("channel")
  const channel = normalizeExternalSaleChannel(channelText)
  if (channel.code === null) {
    errors.push(channel.forbidden === "mercadolibre"
      ? "Las ventas de Mercado Libre se cargan desde su propio importador."
      : "Las ventas de la tienda web ya están registradas como pedidos.")
  } else if (!channel.recognized) {
    warnings.push(`Canal “${channelText}” no reconocido: se guarda como Otro.`)
  }

  const paymentText = value("payment_method")
  const payment = normalizeExternalSalePaymentMethod(paymentText)
  if (!payment.recognized) warnings.push(`Medio de pago “${paymentText}” no reconocido: se guarda como Otro.`)

  const statusText = value("status")
  const status = normalizeExternalSaleStatus(statusText)
  if (status.code === "reversed") errors.push("La venta figura anulada o devuelta: no se importa.")
  else if (!status.recognized) warnings.push(`Estado “${statusText}” no reconocido: se importa como Confirmada.`)

  const productName = value("product_name")
  const customerName = value("customer_name")
  const notes = value("notes")
  if (customerName.length > 180) errors.push("El nombre del cliente es demasiado largo.")
  if (productName.length > 240) errors.push("El nombre del producto es demasiado largo.")
  if (notes.length > 1000) errors.push("La observación es demasiado larga.")

  const payload: ExternalSaleImportRowPayload | null = errors.length || !saleDate || quantity == null || finalPrice == null || channel.code === null
    ? null
    : {
      source_row_number: sourceRowNumber,
      sale_date: saleDate,
      customer_name: customerName || null,
      channel: channel.code,
      channel_label: channelText ? channelText.slice(0, 80) : null,
      sku,
      product_name: productName || null,
      quantity,
      shipping_amount: shipping ?? 0,
      payment_method: paymentText ? paymentText.slice(0, 100) : null,
      payment_method_code: payment.code,
      status: status.code === "delivered" ? "delivered" : "completed",
      gross_amount: finalPrice,
      declared_profit: profit,
      notes: notes || null,
      source_values: sourceValues,
    }

  return {
    sourceRowNumber,
    payload,
    sourceValues,
    errors,
    warnings,
    duplicateKey: payload ? externalSaleDuplicateKey(payload) : null,
  }
}

// ---------------------------------------------------------------------------
// Preview: combina el parseo local con la verificación de la base
// ---------------------------------------------------------------------------

export type ExternalSaleSkuResolution = "ok" | "archived" | "historical" | "needs_variant" | "conditioned" | "missing"

export interface ExternalSalePreviewServerRow {
  index: number
  resolution: ExternalSaleSkuResolution
  product_id: number | null
  variant_id: number | null
  product_name: string | null
  variant_name: string | null
  available_units: number | null
  duplicate_sale_numbers: number[]
}

export type ExternalSalePreviewState = "valid" | "warning" | "error" | "duplicate"

export interface ExternalSalePreviewRow {
  parsed: ParsedExternalSaleRow
  server: ExternalSalePreviewServerRow | null
  state: ExternalSalePreviewState
  messages: string[]
  catalogName: string | null
  /** Posible duplicada: requiere confirmar "Es una venta distinta". */
  duplicateOf: { saleNumbers: number[]; inPaste: boolean } | null
}

const RESOLUTION_ERRORS: Partial<Record<ExternalSaleSkuResolution, string>> = {
  missing: "El SKU no existe en el catálogo.",
  needs_variant: "El SKU es de un producto con variantes: usá el SKU de la variante vendida.",
  conditioned: "El SKU es de stock reacondicionado y no se admite en ventas externas.",
}

/**
 * Clasifica cada fila para el preview según el modo elegido. Con modo
 * "consume" el stock disponible (ya descontadas las reservas web) se reparte
 * en orden entre las filas del mismo artículo.
 */
export function classifyExternalSalePreview(
  rows: ParsedExternalSaleRow[],
  serverRows: ExternalSalePreviewServerRow[] | null,
  mode: ExternalSaleStockEffect | null,
): ExternalSalePreviewRow[] {
  const remainingByTarget = new Map<string, number>()
  const seenKeys = new Set<string>()
  let payloadIndex = 0

  return rows.map((parsed) => {
    const messages = [...parsed.errors]
    const server = parsed.payload && serverRows ? serverRows[payloadIndex] ?? null : null
    if (parsed.payload) payloadIndex += 1
    let blocked = parsed.errors.length > 0
    let warned = parsed.warnings.length > 0
    messages.push(...parsed.warnings)

    if (server) {
      const resolutionError = RESOLUTION_ERRORS[server.resolution]
      if (resolutionError) {
        messages.push(resolutionError)
        blocked = true
      } else if (server.resolution === "archived") {
        messages.push("El producto está archivado.")
        warned = true
      } else if (server.resolution === "historical") {
        if (mode === "consume") {
          messages.push("El SKU ya no está en el catálogo: sólo puede importarse como histórica.")
          blocked = true
        } else {
          messages.push("SKU histórico: ya no está en el catálogo. Se importa sin producto vinculado.")
          warned = true
        }
      }
      if (!blocked && mode === "consume" && server.product_id != null && parsed.payload) {
        const target = `${server.product_id}:${server.variant_id ?? ""}`
        const remaining = remainingByTarget.get(target) ?? Math.max(server.available_units ?? 0, 0)
        if (parsed.payload.quantity > remaining) {
          messages.push(`Stock insuficiente: quedan ${remaining} unidades disponibles (descontando reservas web).`)
          blocked = true
        } else {
          remainingByTarget.set(target, remaining - parsed.payload.quantity)
        }
      }
    }

    let duplicateOf: ExternalSalePreviewRow["duplicateOf"] = null
    if (parsed.duplicateKey) {
      const inPaste = seenKeys.has(parsed.duplicateKey)
      seenKeys.add(parsed.duplicateKey)
      const saleNumbers = server?.duplicate_sale_numbers ?? []
      if (!blocked && (inPaste || saleNumbers.length)) duplicateOf = { saleNumbers, inPaste }
    }

    const catalogName = server?.product_name
      ? `${server.product_name}${server.variant_name ? ` · ${server.variant_name}` : ""}`
      : null
    const state: ExternalSalePreviewState = blocked
      ? "error"
      : duplicateOf
        ? "duplicate"
        : warned
          ? "warning"
          : "valid"
    return { parsed, server, state, messages, catalogName, duplicateOf }
  })
}

// ---------------------------------------------------------------------------
// Validación server-side del contrato (la RPC vuelve a validar todo)
// ---------------------------------------------------------------------------

function optionalText(value: unknown, max: number): string | null | undefined {
  if (value == null) return null
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (trimmed.length > max) return undefined
  return trimmed || null
}

function finiteNumber(value: unknown, { min, integer = false }: { min?: number; integer?: boolean } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null
  if (integer && !Number.isInteger(value)) return null
  if (min != null && value < min) return null
  if (Math.abs(value) > 9_999_999_999) return null
  return value
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value)
}

export function validateExternalSaleImportRow(value: unknown): ExternalSaleImportRowPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const allowed = new Set([
    "source_row_number", "sale_date", "customer_name", "channel", "channel_label", "sku", "product_name",
    "quantity", "shipping_amount", "payment_method", "payment_method_code", "status", "gross_amount",
    "declared_profit", "notes", "source_values", "confirm_duplicate",
  ])
  if (Object.keys(row).some((key) => !allowed.has(key))) return null

  const sourceRowNumber = finiteNumber(row.source_row_number, { min: 1, integer: true })
  const saleDate = typeof row.sale_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(row.sale_date) ? row.sale_date : null
  const sku = optionalText(row.sku, 120)
  const quantity = finiteNumber(row.quantity, { min: 1, integer: true })
  const grossAmount = finiteNumber(row.gross_amount, { min: 0 })
  const shipping = finiteNumber(row.shipping_amount, { min: 0 })
  const declaredProfit = row.declared_profit == null ? null : finiteNumber(row.declared_profit)
  const customerName = optionalText(row.customer_name, 180)
  const channelLabel = optionalText(row.channel_label, 80)
  const productName = optionalText(row.product_name, 240)
  const paymentMethod = optionalText(row.payment_method, 100)
  const notes = optionalText(row.notes, 1000)
  const paymentCode = row.payment_method_code == null ? null : row.payment_method_code

  if (
    sourceRowNumber == null || !saleDate || !sku || quantity == null || quantity > 100000 || grossAmount == null || shipping == null
    || (row.declared_profit != null && declaredProfit == null)
    || customerName === undefined || channelLabel === undefined || productName === undefined
    || paymentMethod === undefined || notes === undefined
    || !isOneOf(EXTERNAL_SALE_CHANNELS, row.channel)
    || (paymentCode !== null && !isOneOf(EXTERNAL_SALE_PAYMENT_METHODS, paymentCode))
    || (row.status !== "completed" && row.status !== "delivered")
    || (row.confirm_duplicate !== undefined && typeof row.confirm_duplicate !== "boolean")
  ) {
    return null
  }

  let sourceValues: Record<string, string> | null = null
  if (row.source_values != null) {
    if (typeof row.source_values !== "object" || Array.isArray(row.source_values)) return null
    const entries = Object.entries(row.source_values as Record<string, unknown>)
    if (entries.length > 40 || entries.some(([header, cell]) => header.length > 120 || typeof cell !== "string" || cell.length > 500)) {
      return null
    }
    sourceValues = Object.fromEntries(entries) as Record<string, string>
  }

  return {
    source_row_number: sourceRowNumber,
    sale_date: saleDate,
    customer_name: customerName,
    channel: row.channel as ExternalSaleChannel,
    channel_label: channelLabel,
    sku,
    product_name: productName,
    quantity,
    shipping_amount: shipping,
    payment_method: paymentMethod,
    payment_method_code: paymentCode as ExternalSalePaymentMethod | null,
    status: row.status as ExternalSaleActiveStatus,
    gross_amount: grossAmount,
    declared_profit: declaredProfit,
    notes,
    source_values: sourceValues,
    ...(row.confirm_duplicate === true ? { confirm_duplicate: true } : {}),
  }
}

export function externalSaleCode(saleNumber: number | null | undefined) {
  return saleNumber ? `VE-${String(saleNumber).padStart(6, "0")}` : "VE-—"
}
