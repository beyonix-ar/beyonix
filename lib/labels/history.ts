import { isPrintableBarcode } from "../barcodes/codes.ts"
import { MAX_LABEL_NAME_LENGTH, MAX_QUEUE_ITEMS, parseCopies, type LabelQueueItem } from "./queue.ts"
import { MAX_BATCH_LABELS, MAX_COPIES_LIMIT, normalizeLabelSettings, type LabelSettings } from "./settings.ts"

export type LabelBatchOutput = "print" | "pdf" | "zpl"

export interface LabelBatchItem {
  productId: number
  variantId: number | null
  code: string
  copies: number
  labelName: string | null
}

export interface LabelBatchSummary {
  id: string
  name: string
  labelCount: number
  output: LabelBatchOutput
  createdAt: string
  items: LabelBatchItem[]
}

export interface LabelPreset {
  id: string
  name: string
  settings: LabelSettings
  updatedAt: string
}

export const MAX_PRESET_NAME_LENGTH = 60
export const MAX_BATCH_NAME_LENGTH = 120
export const LABEL_HISTORY_LIMIT = 20

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const positiveId = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null)

export function cleanName(value: unknown, max: number) {
  return typeof value === "string" ? value.normalize("NFC").replace(/\s+/g, " ").trim().slice(0, max) : ""
}

export function parseBatchItems(value: unknown): LabelBatchItem[] | null {
  if (!Array.isArray(value) || !value.length || value.length > MAX_QUEUE_ITEMS) return null
  const items: LabelBatchItem[] = []
  for (const raw of value) {
    if (!isRecord(raw)) return null
    const productId = positiveId(raw.productId)
    const variantId = raw.variantId == null ? null : positiveId(raw.variantId)
    const code = typeof raw.code === "string" ? raw.code.trim() : ""
    const copies = parseCopies(raw.copies, MAX_COPIES_LIMIT)
    if (!productId || (raw.variantId != null && !variantId) || !code || code.length > 64 || !isPrintableBarcode(code) || !copies) return null
    if (typeof raw.copies !== "number" || raw.copies !== copies) return null
    const labelName = cleanName(raw.labelName, MAX_LABEL_NAME_LENGTH) || null
    items.push({ productId, variantId, code, copies, labelName })
  }
  const total = items.reduce((sum, item) => sum + item.copies, 0)
  return total <= MAX_BATCH_LABELS ? items : null
}

export function batchLabelCount(items: readonly LabelBatchItem[]) {
  return items.reduce((sum, item) => sum + item.copies, 0)
}

// "Encendedor USB + Botella Smart +2": nombres únicos en orden de la cola.
export function defaultBatchName(items: readonly Pick<LabelQueueItem, "productName">[]) {
  const names = [...new Set(items.map((item) => item.productName.trim()).filter(Boolean))]
  if (!names.length) return "Tanda de etiquetas"
  const head = names.slice(0, 2).join(" + ")
  return cleanName(names.length > 2 ? `${head} +${names.length - 2}` : head, MAX_BATCH_NAME_LENGTH)
}

export function toBatchItems(queue: readonly LabelQueueItem[]): LabelBatchItem[] {
  return queue.filter((item) => !item.issue).map((item) => ({
    productId: item.productId,
    variantId: item.variantId,
    code: item.code,
    copies: item.copies,
    labelName: item.labelName,
  }))
}

export function parsePresetPayload(value: unknown): { name: string; settings: LabelSettings; overwrite: boolean } | null {
  if (!isRecord(value) || !isRecord(value.settings)) return null
  const name = cleanName(value.name, MAX_PRESET_NAME_LENGTH)
  if (!name) return null
  return { name, settings: normalizeLabelSettings(value.settings), overwrite: value.overwrite === true }
}

export function parseBatchOutput(value: unknown): LabelBatchOutput | null {
  return value === "print" || value === "pdf" || value === "zpl" ? value : null
}
