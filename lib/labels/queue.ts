import type { LabelCatalogProduct, LabelCodeSource, LabelTarget } from "./catalog.ts"
import { buildLabelTargets } from "./catalog.ts"
import { MAX_COPIES_LIMIT, type LabelPrintOrder } from "./settings.ts"

// Cola de impresión: estado local del navegador (no se guarda en la base). La
// fuente de verdad de nombres y códigos es el catálogo; `reconcileQueue` la
// vuelve a validar contra el servidor antes de imprimir.
export interface LabelQueueItem {
  key: string
  productId: number
  variantId: number | null
  productName: string
  variantLabel: string | null
  colorHex: string | null
  colorHexSecondary: string | null
  sku: string | null
  price: number | null
  code: string
  codeSource: LabelCodeSource
  internalCode: string
  copies: number
  /** Texto corto sólo para la etiqueta; no cambia el nombre comercial. */
  labelName: string | null
  /** Motivo por el que no se puede imprimir (código cambiado, artículo borrado). */
  issue: string | null
}

export const LABEL_QUEUE_STORAGE_KEY = "beyonix-label-queue-v1"
export const MAX_QUEUE_ITEMS = 300
export const MAX_LABEL_NAME_LENGTH = 60

export function queueItemKey(productId: number, variantId: number | null, code: string) {
  return `${productId}:${variantId ?? 0}:${code.trim().toUpperCase()}`
}

/** Entero entre 1 y `max`; cualquier otra cosa (0, negativos, NaN, decimales) → null. */
export function parseCopies(value: unknown, max = MAX_COPIES_LIMIT) {
  const number = typeof value === "number" ? value : typeof value === "string" && /^\s*\d+\s*$/.test(value) ? Number(value) : Number.NaN
  if (!Number.isSafeInteger(number) || number < 1) return null
  return Math.min(number, Math.max(1, Math.floor(max)))
}

export function createQueueItem(target: LabelTarget, code: string, copies: number): LabelQueueItem | null {
  const option = target.options.find((candidate) => candidate.code === code.trim())
  const safeCopies = parseCopies(copies)
  if (!option || !safeCopies) return null
  return {
    key: queueItemKey(target.productId, target.variantId, option.code),
    productId: target.productId,
    variantId: target.variantId,
    productName: target.productName,
    variantLabel: target.variantLabel,
    colorHex: target.colorHex,
    colorHexSecondary: target.colorHexSecondary,
    sku: target.sku,
    price: target.price,
    code: option.code,
    codeSource: option.source,
    internalCode: target.internalCode,
    copies: safeCopies,
    labelName: null,
    issue: null,
  }
}

export type QueueAddResult = { queue: LabelQueueItem[]; merged: boolean; clamped: boolean; rejected: boolean }

// Agregar dos veces el mismo artículo + código suma cantidades (hasta el tope).
export function addToQueue(queue: readonly LabelQueueItem[], item: LabelQueueItem, maxCopies: number): QueueAddResult {
  const max = Math.max(1, Math.floor(maxCopies))
  const existing = queue.find((entry) => entry.key === item.key)
  if (existing) {
    const total = existing.copies + item.copies
    return {
      queue: queue.map((entry) => (entry.key === item.key ? { ...entry, copies: Math.min(total, max), issue: null } : entry)),
      merged: true,
      clamped: total > max,
      rejected: false,
    }
  }
  if (queue.length >= MAX_QUEUE_ITEMS) return { queue: [...queue], merged: false, clamped: false, rejected: true }
  return { queue: [...queue, { ...item, copies: Math.min(item.copies, max) }], merged: false, clamped: item.copies > max, rejected: false }
}

export function setQueueCopies(queue: readonly LabelQueueItem[], key: string, copies: unknown, maxCopies: number) {
  const value = parseCopies(copies, maxCopies)
  if (!value) return [...queue]
  return queue.map((entry) => (entry.key === key ? { ...entry, copies: value } : entry))
}

export function stepQueueCopies(queue: readonly LabelQueueItem[], key: string, delta: number, maxCopies: number) {
  const entry = queue.find((item) => item.key === key)
  if (!entry) return [...queue]
  return setQueueCopies(queue, key, Math.min(Math.max(1, entry.copies + delta), maxCopies), maxCopies)
}

export function removeFromQueue(queue: readonly LabelQueueItem[], key: string) {
  return queue.filter((entry) => entry.key !== key)
}

export function moveQueueItem(queue: readonly LabelQueueItem[], key: string, delta: -1 | 1) {
  const index = queue.findIndex((entry) => entry.key === key)
  const target = index + delta
  if (index < 0 || target < 0 || target >= queue.length) return [...queue]
  const next = [...queue]
  ;[next[index], next[target]] = [next[target], next[index]]
  return next
}

export function setQueueLabelName(queue: readonly LabelQueueItem[], key: string, value: string) {
  const clean = value.replace(/\s+/g, " ").slice(0, MAX_LABEL_NAME_LENGTH)
  return queue.map((entry) => (entry.key === key ? { ...entry, labelName: clean.trim() ? clean : null } : entry))
}

// Cambiar el código impreso de una fila; si ya existe otra fila con ese
// artículo + código, se unen.
export function changeQueueCode(queue: readonly LabelQueueItem[], key: string, target: LabelTarget, code: string, maxCopies: number) {
  const entry = queue.find((item) => item.key === key)
  const replacement = entry && createQueueItem(target, code, entry.copies)
  if (!entry || !replacement || replacement.key === key) return [...queue]
  const updated = { ...replacement, labelName: entry.labelName }
  const duplicate = queue.find((item) => item.key === updated.key)
  if (duplicate) {
    return queue
      .filter((item) => item.key !== key)
      .map((item) => (item.key === updated.key ? { ...item, copies: Math.min(item.copies + entry.copies, maxCopies) } : item))
  }
  return queue.map((item) => (item.key === key ? updated : item))
}

export function printableQueue(queue: readonly LabelQueueItem[]) {
  return queue.filter((entry) => !entry.issue)
}

export function queueLabelCount(queue: readonly LabelQueueItem[]) {
  return printableQueue(queue).reduce((total, entry) => total + entry.copies, 0)
}

const compareText = (left: string, right: string) => left.localeCompare(right, "es", { sensitivity: "base", numeric: true })

// Orden manual = el de la cola. Agrupar por producto junta las filas del mismo
// producto en la posición de su primera aparición; por variante, además ordena
// alfabéticamente producto → variante.
export function orderQueue(queue: readonly LabelQueueItem[], order: LabelPrintOrder) {
  const items = printableQueue(queue)
  if (order === "manual") return items
  if (order === "product") {
    const firstIndex = new Map<number, number>()
    items.forEach((entry, index) => { if (!firstIndex.has(entry.productId)) firstIndex.set(entry.productId, index) })
    return items
      .map((entry, index) => ({ entry, index }))
      .sort((left, right) => (firstIndex.get(left.entry.productId) ?? 0) - (firstIndex.get(right.entry.productId) ?? 0) || left.index - right.index)
      .map(({ entry }) => entry)
  }
  return [...items].sort((left, right) =>
    compareText(left.productName, right.productName) ||
    left.productId - right.productId ||
    compareText(left.variantLabel ?? "", right.variantLabel ?? "") ||
    compareText(left.code, right.code))
}

/** Una entrada por etiqueta física, en el orden de impresión. */
export function expandQueue(queue: readonly LabelQueueItem[], order: LabelPrintOrder) {
  return orderQueue(queue, order).flatMap((entry) => Array.from({ length: entry.copies }, () => entry))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value : null)
const id = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null)

// La cola guardada en el navegador se trata como dato no confiable.
export function parseStoredQueue(value: unknown): LabelQueueItem[] {
  if (!Array.isArray(value)) return []
  const items: LabelQueueItem[] = []
  for (const raw of value.slice(0, MAX_QUEUE_ITEMS)) {
    if (!isRecord(raw)) continue
    const productId = id(raw.productId)
    const variantId = raw.variantId == null ? null : id(raw.variantId)
    const code = text(raw.code)?.trim()
    const copies = parseCopies(raw.copies)
    const source = raw.codeSource === "alias" || raw.codeSource === "sku" ? raw.codeSource : "principal"
    if (!productId || (raw.variantId != null && !variantId) || !code || !copies) continue
    const key = queueItemKey(productId, variantId, code)
    if (items.some((item) => item.key === key)) continue
    items.push({
      key,
      productId,
      variantId,
      productName: text(raw.productName) ?? `Producto #${productId}`,
      variantLabel: text(raw.variantLabel),
      colorHex: text(raw.colorHex),
      colorHexSecondary: text(raw.colorHexSecondary),
      sku: text(raw.sku),
      price: typeof raw.price === "number" && Number.isFinite(raw.price) ? raw.price : null,
      code,
      codeSource: source,
      internalCode: text(raw.internalCode) ?? `#${productId}${variantId ? `-${variantId}` : ""}`,
      copies,
      labelName: text(raw.labelName)?.slice(0, MAX_LABEL_NAME_LENGTH) ?? null,
      issue: text(raw.issue),
    })
  }
  return items
}

export function findTarget(products: readonly LabelCatalogProduct[], productId: number, variantId: number | null) {
  const product = products.find((candidate) => candidate.id === productId)
  return product ? buildLabelTargets(product).targets.find((target) => target.variantId === variantId) ?? null : null
}

// Revalida cada fila contra el catálogo actual: refresca nombre, color, SKU y
// precio, y marca (sin borrar) las filas cuyo artículo o código ya no existe.
export function reconcileQueue(queue: readonly LabelQueueItem[], products: readonly LabelCatalogProduct[]) {
  return queue.map((entry): LabelQueueItem => {
    const target = findTarget(products, entry.productId, entry.variantId)
    if (!target) return { ...entry, issue: entry.variantId ? "La variante ya no existe." : "El producto ya no existe o ahora tiene variantes." }
    const option = target.options.find((candidate) => candidate.code.toUpperCase() === entry.code.toUpperCase())
    if (!option) return { ...entry, productName: target.productName, variantLabel: target.variantLabel, issue: "Este código ya no pertenece al artículo. Elegí otro." }
    return {
      ...entry,
      productName: target.productName,
      variantLabel: target.variantLabel,
      colorHex: target.colorHex,
      colorHexSecondary: target.colorHexSecondary,
      sku: target.sku,
      price: target.price,
      code: option.code,
      codeSource: option.source,
      internalCode: target.internalCode,
      issue: null,
    }
  })
}
