import type { createAdminClient } from "@/lib/supabase/admin"

// Conciliación de facturación Andreani. No hay API de facturación/liquidación
// confirmada: los cargos se registran a mano (por pedido) o se importan por
// CSV. Las reglas de estado y los umbrales viven en la base
// (andreani_reconciliation_status / andreani_reconciliation_thresholds); acá
// sólo se parsea la entrada y se traducen códigos a textos.

type AdminClient = ReturnType<typeof createAdminClient>

export const BILLING_MOVEMENT_TYPES = ["outbound", "return", "exchange_return", "exchange_resend", "other"] as const
export type BillingMovementType = (typeof BILLING_MOVEMENT_TYPES)[number]
export const BILLING_MOVEMENT_LABELS: Record<BillingMovementType, string> = {
  outbound: "Envío",
  return: "Devolución",
  exchange_return: "Cambio · retiro",
  exchange_resend: "Cambio · reenvío",
  other: "Otro",
}
export const isBillingMovementType = (value: unknown): value is BillingMovementType =>
  typeof value === "string" && (BILLING_MOVEMENT_TYPES as readonly string[]).includes(value)

export type ReconciliationStatus = "pending" | "reconciled" | "minor_difference" | "major_difference" | "no_reference"
export const RECONCILIATION_LABELS: Record<ReconciliationStatus, string> = {
  pending: "Pendiente",
  reconciled: "Conciliado",
  minor_difference: "Diferencia menor",
  major_difference: "Diferencia importante",
  no_reference: "Sin referencia",
}
export const UNMATCHED_LABEL = "Sin pedido asociado"
export const isReconciliationStatus = (value: unknown): value is ReconciliationStatus =>
  typeof value === "string" && value in RECONCILIATION_LABELS

export const BILLED_HELP = "Importe registrado desde la factura o liquidación real de Andreani (con IVA)."

/** Un cargo para record_andreani_billing_entries (ya normalizado). */
export interface BillingEntryInput {
  orderId?: number
  tracking: string | null
  amount: string
  billedOn: string
  reference: string
  movementType?: BillingMovementType
  notes?: string | null
}

// ─── CSV ────────────────────────────────────────────────────────────────────

export const MAX_BILLING_CSV_BYTES = 1_000_000
export const MAX_BILLING_CSV_ROWS = 2000

export class BillingCsvError extends Error {}

export type BillingField = "tracking" | "amount" | "billedOn" | "reference" | "movementType" | "notes"
export type BillingColumnMapping = Partial<Record<BillingField, string>>
export const REQUIRED_BILLING_FIELDS: BillingField[] = ["tracking", "amount", "billedOn", "reference"]
export const BILLING_FIELD_LABELS: Record<BillingField, string> = {
  tracking: "Tracking",
  amount: "Importe",
  billedOn: "Fecha",
  reference: "Referencia / factura",
  movementType: "Tipo (opcional)",
  notes: "Observación (opcional)",
}

const normalizeHeader = (value: string) =>
  value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()

const HEADER_ALIASES: Record<BillingField, string[]> = {
  tracking: ["tracking", "numero de envio", "nro de envio", "n de envio", "envio", "numero andreani", "codigo de seguimiento", "seguimiento"],
  amount: ["importe", "monto", "total", "importe total", "importe facturado", "importe con iva", "precio"],
  billedOn: ["fecha", "fecha factura", "fecha de factura", "fecha facturacion", "fecha de facturacion", "fecha liquidacion", "fecha emision"],
  reference: ["referencia", "factura", "numero de factura", "nro factura", "comprobante", "liquidacion", "numero de liquidacion"],
  movementType: ["tipo", "tipo de movimiento", "movimiento"],
  notes: ["observacion", "observaciones", "nota", "notas", "detalle"],
}

/** Mapeo automático por nombre de columna (sin tildes ni mayúsculas). */
export function detectBillingColumns(headers: string[]): BillingColumnMapping {
  const mapping: BillingColumnMapping = {}
  const used = new Set<string>()
  for (const field of Object.keys(HEADER_ALIASES) as BillingField[]) {
    const match = headers.find((header) => !used.has(header) && HEADER_ALIASES[field].includes(normalizeHeader(header)))
    if (match) {
      mapping[field] = match
      used.add(match)
    }
  }
  return mapping
}

function detectDelimiter(firstLine: string) {
  const count = (char: string) => firstLine.split(char).length - 1
  return count(";") > count(",") ? ";" : count("\t") > count(",") ? "\t" : ","
}

/** CSV con comillas dobles (RFC 4180), separador , ; o tab, BOM y CRLF. */
export function parseBillingCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  if (text.length > MAX_BILLING_CSV_BYTES) throw new BillingCsvError("El archivo supera 1 MB.")
  const source = text.replace(/^﻿/, "")
  if (!source.trim()) throw new BillingCsvError("El archivo está vacío.")
  const delimiter = detectDelimiter(source.slice(0, source.search(/\r?\n|$/)))
  const records: string[][] = []
  let field = ""
  let record: string[] = []
  let quoted = false
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (quoted) {
      if (char === "\"" && source[index + 1] === "\"") { field += "\""; index += 1 }
      else if (char === "\"") quoted = false
      else field += char
      continue
    }
    if (char === "\"" && field === "") quoted = true
    else if (char === delimiter) { record.push(field); field = "" }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[index + 1] === "\n") index += 1
      record.push(field); field = ""
      if (record.some((value) => value.trim())) records.push(record)
      record = []
      if (records.length > MAX_BILLING_CSV_ROWS + 1) throw new BillingCsvError(`El archivo supera ${MAX_BILLING_CSV_ROWS} filas.`)
    } else field += char
  }
  if (quoted) throw new BillingCsvError("El archivo tiene comillas sin cerrar.")
  record.push(field)
  if (record.some((value) => value.trim())) records.push(record)
  if (records.length > MAX_BILLING_CSV_ROWS + 1) throw new BillingCsvError(`El archivo supera ${MAX_BILLING_CSV_ROWS} filas.`)
  const [headerRow, ...dataRows] = records
  const headers = headerRow.map((header) => header.trim())
  if (!headers.length || headers.some((header) => !header) || new Set(headers).size !== headers.length) {
    throw new BillingCsvError("La primera fila debe tener nombres de columna únicos.")
  }
  if (!dataRows.length) throw new BillingCsvError("El archivo no tiene filas para importar.")
  return {
    headers,
    rows: dataRows.map((values) => Object.fromEntries(headers.map((header, column) => [header, (values[column] ?? "").trim()]))),
  }
}

/**
 * Importe en formato argentino o internacional → "1234.56". Acepta "$ 8.500",
 * "8.500,50", "8500.5", "8,500.50". Un único punto seguido de exactamente 3
 * dígitos se toma como separador de miles (formato argentino: "8.500").
 */
export function parseBillingAmount(value: string): string | null {
  const cleaned = value.replace(/[$\s]|ARS/gi, "")
  if (!/^\d[\d.,]*$/.test(cleaned)) return null
  const lastComma = cleaned.lastIndexOf(",")
  const lastDot = cleaned.lastIndexOf(".")
  let normalized: string
  if (lastComma >= 0 && lastDot >= 0) {
    const decimal = lastComma > lastDot ? "," : "."
    const thousands = decimal === "," ? "." : ","
    normalized = cleaned.split(thousands).join("").replace(decimal, ".")
  } else if (lastComma >= 0) {
    normalized = /^\d{1,3}(,\d{3})+$/.test(cleaned) ? cleaned.replace(/,/g, "") : cleaned.replace(",", ".")
  } else if (lastDot >= 0) {
    normalized = /^\d{1,3}(\.\d{3})+$/.test(cleaned) ? cleaned.replace(/\./g, "") : cleaned
  } else normalized = cleaned
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(normalized)) return null
  return normalized
}

/** Fecha "AAAA-MM-DD" o "DD/MM/AAAA" (también con - o .) → "AAAA-MM-DD". */
export function parseBillingDate(value: string): string | null {
  const trimmed = value.trim()
  let year: number, month: number, day: number
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(trimmed)
  if (match) [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  else if ((match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(trimmed))) [day, month, year] = [Number(match[1]), Number(match[2]), Number(match[3])]
  else return null
  const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
  const date = new Date(`${iso}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === iso ? iso : null
}

const MOVEMENT_ALIASES: Record<string, BillingMovementType> = {
  envio: "outbound", entrega: "outbound", outbound: "outbound",
  devolucion: "return", return: "return",
  "cambio retiro": "exchange_return", "retiro cambio": "exchange_return", exchange_return: "exchange_return",
  reenvio: "exchange_resend", "cambio reenvio": "exchange_resend", exchange_resend: "exchange_resend",
  otro: "other", other: "other",
}

export type BillingRowError = { row: number; error: string }

/**
 * Filas del CSV → cargos válidos (con su número de fila del archivo en
 * rowNumbers, mismo índice) + errores por fila.
 */
export function billingEntriesFromCsv(rows: Record<string, string>[], mapping: BillingColumnMapping) {
  const missing = REQUIRED_BILLING_FIELDS.filter((field) => !mapping[field])
  if (missing.length) {
    throw new BillingCsvError(`Asigná las columnas: ${missing.map((field) => BILLING_FIELD_LABELS[field]).join(", ")}.`)
  }
  const entries: BillingEntryInput[] = []
  const rowNumbers: number[] = []
  const errors: BillingRowError[] = []
  rows.forEach((values, index) => {
    const row = index + 2
    const read = (field: BillingField) => (mapping[field] ? values[mapping[field]] ?? "" : "")
    const amount = parseBillingAmount(read("amount"))
    const billedOn = parseBillingDate(read("billedOn"))
    const reference = read("reference").trim()
    const movementRaw = read("movementType").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim().replace(/[\s·-]+/g, " ")
    const movementType = movementRaw ? MOVEMENT_ALIASES[movementRaw] : undefined
    if (!amount) errors.push({ row, error: "Importe inválido." })
    else if (!billedOn) errors.push({ row, error: "Fecha inválida (usá AAAA-MM-DD o DD/MM/AAAA)." })
    else if (!reference || reference.length > 80) errors.push({ row, error: "Falta la referencia / número de factura." })
    else if (movementRaw && !movementType) errors.push({ row, error: "Tipo de movimiento desconocido." })
    else {
      rowNumbers.push(row)
      entries.push({
        tracking: read("tracking").replace(/\s/g, "").toUpperCase() || null,
        amount,
        billedOn,
        reference,
        ...(movementType ? { movementType } : {}),
        notes: read("notes").trim().slice(0, 1000) || null,
      })
    }
  })
  return { entries, rowNumbers, errors }
}

// ─── Base de datos ──────────────────────────────────────────────────────────

export type BillingRecordStatus = "created" | "duplicate" | "conflict" | "invalid" | "ready"
export interface BillingRecordResult {
  index: number
  status: BillingRecordStatus
  entryId?: number
  orderId?: number | null
  matchStatus?: "matched" | "unmatched"
  unmatchedReason?: "not_found" | "ambiguous" | "no_tracking" | null
  movementType?: BillingMovementType
  error?: string
}

const BILLING_ERRORS: Record<string, string> = {
  LOGISTICS_FORBIDDEN: "Sólo Admin puede conciliar la logística.",
  BILLING_SOURCE_INVALID: "Origen de carga inválido.",
  BILLING_ENTRIES_INVALID: "No hay cargos válidos para registrar (máximo 2000 por vez).",
  BILLING_ROW_INVALID: "Datos del cargo inválidos.",
  BILLING_TRACKING_INVALID: "Tracking inválido.",
  BILLING_TRACKING_OTHER_ORDER: "Ese tracking pertenece a otro pedido.",
  BILLING_AMOUNT_INVALID: "Importe inválido.",
  BILLING_DATE_INVALID: "Fecha inválida.",
  BILLING_REFERENCE_INVALID: "Ingresá la referencia o número de factura (hasta 80 caracteres).",
  BILLING_NOTES_INVALID: "La observación es demasiado larga.",
  BILLING_MOVEMENT_INVALID: "Tipo de movimiento inválido.",
  BILLING_ORDER_NOT_FOUND: "No se encontró el pedido.",
  BILLING_REASON_REQUIRED: "Indicá el motivo de la corrección (mínimo 5 caracteres).",
  BILLING_ENTRY_NOT_FOUND: "El cargo ya no existe.",
  BILLING_ALREADY_MATCHED: "El cargo ya está asociado a un pedido.",
  BILLING_DUPLICATE: "Ya existe un cargo con esa referencia, tracking y tipo.",
}

export function billingErrorMessage(message: string | null | undefined, fallback = "No se pudo registrar la facturación.") {
  const code = Object.keys(BILLING_ERRORS).sort((left, right) => right.length - left.length).find((key) => message?.includes(key))
  return code ? BILLING_ERRORS[code] : fallback
}

export async function recordBillingEntries(admin: AdminClient, input: {
  entries: BillingEntryInput[]
  source: "manual" | "csv"
  actorId: string
  dryRun?: boolean
}): Promise<BillingRecordResult[]> {
  const { data, error } = await admin.rpc("record_andreani_billing_entries", {
    p_entries: input.entries,
    p_source: input.source,
    p_actor_id: input.actorId,
    p_dry_run: Boolean(input.dryRun),
  })
  if (error) throw new Error(error.message)
  if (!Array.isArray(data)) throw new Error("BILLING_RESPONSE_INVALID")
  return (data as BillingRecordResult[]).map((result) => (
    result.status === "invalid" ? { ...result, error: billingErrorMessage(result.error, "Fila inválida.") } : result
  ))
}

export interface BillingEntry {
  id: number
  orderId: number | null
  movementType: BillingMovementType
  tracking: string | null
  amount: number
  billedOn: string
  reference: string
  source: "manual" | "csv" | "api"
  notes: string | null
  matchStatus: "matched" | "unmatched"
  unmatchedReason: "not_found" | "ambiguous" | "no_tracking" | null
  createdAt: string
  updatedAt: string | null
  correctionReason: string | null
}

type BillingEntryRow = {
  id: number; order_id: number | null; movement_type: BillingMovementType; tracking: string | null
  billed_amount: number | string; billed_on: string; invoice_reference: string; source: BillingEntry["source"]
  notes: string | null; match_status: BillingEntry["matchStatus"]; unmatched_reason: BillingEntry["unmatchedReason"]
  created_at: string; updated_at: string | null; correction_reason: string | null
}
const ENTRY_COLUMNS = "id,order_id,movement_type,tracking,billed_amount,billed_on,invoice_reference,source,notes,match_status,unmatched_reason,created_at,updated_at,correction_reason"

const toBillingEntry = (row: BillingEntryRow): BillingEntry => ({
  id: Number(row.id),
  orderId: row.order_id === null ? null : Number(row.order_id),
  movementType: row.movement_type,
  tracking: row.tracking,
  amount: Number(row.billed_amount),
  billedOn: row.billed_on,
  reference: row.invoice_reference,
  source: row.source,
  notes: row.notes,
  matchStatus: row.match_status,
  unmatchedReason: row.unmatched_reason,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  correctionReason: row.correction_reason,
})

export async function loadOrderBillingEntries(admin: AdminClient, orderId: number) {
  const { data, error } = await admin.from("andreani_billing_entries").select(ENTRY_COLUMNS).eq("order_id", orderId).order("id")
  if (error) throw new Error("BILLING_LOAD_FAILED")
  return ((data ?? []) as BillingEntryRow[]).map(toBillingEntry)
}

/** Cargos sin pedido asociado facturados en el período (fecha de factura). */
export async function loadUnmatchedBillingEntries(admin: AdminClient, range: { from: string; to: string }) {
  const { data, error } = await admin.from("andreani_billing_entries").select(ENTRY_COLUMNS)
    .eq("match_status", "unmatched").gte("billed_on", range.from).lte("billed_on", range.to)
    .order("billed_on", { ascending: false }).limit(200)
  if (error) throw new Error("BILLING_LOAD_FAILED")
  return ((data ?? []) as BillingEntryRow[]).map(toBillingEntry)
}

export async function updateBillingEntry(admin: AdminClient, input: {
  entryId: number
  patch: Partial<{ amount: string; billedOn: string; reference: string; notes: string | null; movementType: BillingMovementType; orderId: number }>
  reason: string
  actorId: string
}) {
  const { data, error } = await admin.rpc("update_andreani_billing_entry", {
    p_entry_id: input.entryId,
    p_patch: input.patch,
    p_reason: input.reason,
    p_actor_id: input.actorId,
  })
  if (error) throw new Error(error.message)
  return toBillingEntry((Array.isArray(data) ? data[0] : data) as BillingEntryRow)
}
