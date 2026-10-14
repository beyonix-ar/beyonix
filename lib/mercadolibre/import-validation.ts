/**
 * Validación server-side de las filas de ventas ML que llegan del navegador
 * y traducción de errores de base de datos a mensajes entendibles.
 */

export const MERCADOLIBRE_IMPORT_CHUNK_ROWS = 500

export interface MercadoLibreServerRow {
  sale_date: string
  operation_id: string
  order_id: string
  product_name: string
  sku: string | null
  quantity: number
  gross_amount: number
  fee_amount: number | null
  shipping_amount: number | null
  net_amount: number | null
  raw_data: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function finiteOrNull(value: unknown): number | null | undefined {
  if (value == null) return null
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function rowLabel(row: Record<string, unknown>, index: number) {
  const source = isRecord(row.raw_data) && isRecord(row.raw_data.source) ? row.raw_data.source : null
  const rowNumber = source && typeof source.row_number === "number" ? source.row_number : null
  return rowNumber ? `Fila ${rowNumber}` : `Registro ${index + 1}`
}

export type ServerRowsResult =
  | { ok: true; rows: MercadoLibreServerRow[] }
  | { ok: false; error: string }

export function validateMercadoLibreServerRows(input: unknown): ServerRowsResult {
  if (!Array.isArray(input) || input.length === 0) {
    return { ok: false, error: "No hay ventas para importar." }
  }
  if (input.length > MERCADOLIBRE_IMPORT_CHUNK_ROWS) {
    return { ok: false, error: `Cada envío admite hasta ${MERCADOLIBRE_IMPORT_CHUNK_ROWS} ventas.` }
  }

  const rows: MercadoLibreServerRow[] = []
  for (const [index, value] of input.entries()) {
    if (!isRecord(value)) return { ok: false, error: `Registro ${index + 1}: formato inválido.` }
    const label = rowLabel(value, index)
    const operationId = typeof value.operation_id === "string" ? value.operation_id.trim() : ""
    if (!/^\d+$/.test(operationId)) return { ok: false, error: `${label}: el número de venta no es válido.` }

    const saleDate = typeof value.sale_date === "string" ? value.sale_date : ""
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([+-]\d{2}:\d{2}|Z)$/.test(saleDate) || Number.isNaN(Date.parse(saleDate))) {
      return { ok: false, error: `${label}: la fecha de venta no es válida.` }
    }

    const quantity = value.quantity
    if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1 || quantity > 100_000) {
      return { ok: false, error: `${label}: las unidades no son válidas.` }
    }

    const gross = finiteOrNull(value.gross_amount)
    const fee = finiteOrNull(value.fee_amount)
    const shipping = finiteOrNull(value.shipping_amount)
    const net = finiteOrNull(value.net_amount)
    if (gross == null || fee === undefined || shipping === undefined || net === undefined) {
      return { ok: false, error: `${label}: algún importe no es un número válido.` }
    }
    if ([gross, fee, shipping, net].some((amount) => amount != null && Math.abs(amount) >= 1e10)) {
      return { ok: false, error: `${label}: un importe supera el máximo admitido.` }
    }

    const productName = typeof value.product_name === "string" ? value.product_name.trim() : ""
    if (!productName || productName.length > 500) {
      return { ok: false, error: `${label}: falta el nombre del producto o es demasiado largo.` }
    }
    const raw = value.raw_data
    if (!isRecord(raw) || raw.report_format !== "mercadolibre_ventas_ar" || !isRecord(raw.parsed)) {
      return { ok: false, error: `${label}: faltan los datos originales del reporte.` }
    }

    const orderId = typeof value.order_id === "string" && value.order_id.trim() ? value.order_id.trim() : operationId
    const sku = typeof value.sku === "string" && value.sku.trim() ? value.sku.trim().slice(0, 200) : null
    rows.push({
      sale_date: saleDate,
      operation_id: operationId,
      order_id: orderId,
      product_name: productName,
      sku,
      quantity,
      gross_amount: gross,
      fee_amount: fee,
      shipping_amount: shipping,
      net_amount: net,
      raw_data: raw,
    })
  }
  return { ok: true, rows }
}

const KNOWN_ERRORS: Array<[RegExp, string]> = [
  [/STOCK_INSUFICIENTE/, "La importación dejaría stock negativo en productos vinculados. Revisá el stock o la vinculación de SKU; este bloque no se guardó."],
  [/ML_IMPORT_RETURN_CONFLICT/, "Una venta ya tiene unidades recibidas en devolución y el archivo informa menos unidades. Este bloque no se guardó."],
  [/ML_IMPORT_CONFLICT/, "El archivo tiene la misma venta repetida con datos distintos. Este bloque no se guardó."],
  [/ML_IMPORT_BATCH_CLOSED/, "Esta importación ya fue cerrada o revertida. Volvé a analizar el archivo."],
  [/ML_IMPORT_BATCH_NOT_FOUND/, "No se encontró la importación. Volvé a analizar el archivo."],
  [/ML_IMPORT_BATCH_NOT_REVERSIBLE/, "Esta importación ya fue revertida o todavía está en curso."],
  [/ML_IMPORT_REVERT_CHANGED/, "Las ventas de esta importación cambiaron mientras confirmabas. Recargá el historial y volvé a intentarlo."],
  [/schema cache|does not exist|import_mercadolibre_sales_batch|mercadolibre_import_batches/i, "Falta aplicar la migración 20261015100000_mercadolibre_import_batches.sql."],
]

/** Mensaje para el usuario: los errores de la base se traducen; nunca se muestra SQL. */
export function describeMercadoLibreImportError(message: string | null | undefined, fallback: string) {
  const source = message ?? ""
  for (const [pattern, friendly] of KNOWN_ERRORS) {
    if (pattern.test(source)) return friendly
  }
  const explicit = source.match(/ML_IMPORT_INVALID_ROW: (.+)$/)
  if (explicit) return `${explicit[1].charAt(0).toUpperCase()}${explicit[1].slice(1)} Este bloque no se guardó.`
  return fallback
}

export function isMissingImportMigration(message: string | null | undefined) {
  return /schema cache|does not exist|import_mercadolibre_sales_batch|mercadolibre_import_batches/i.test(message ?? "")
}

/** Resultado de comparar una fila del archivo con lo ya cargado. */
export type MercadoLibrePreviewStatus = "new" | "unchanged" | "changed" | "stale"
