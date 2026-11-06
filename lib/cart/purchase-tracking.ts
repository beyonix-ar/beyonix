/**
 * Compras iniciadas desde el carrito que todavía pueden descontarse de él.
 *
 * El carrito vive en el navegador (sessionStorage del invitado / localStorage
 * de la cuenta). Al crear un pedido (Mercado Pago, transferencia o saldo) se
 * registra acá SÓLO su id (y el token de invitado si corresponde). Después, el
 * servidor (/api/checkout/purchase-status) verifica que el pedido sea de quien
 * pregunta y que su pago esté confirmado; recién entonces devuelve los ítems
 * comprados y el carrito descuenta exactamente esas cantidades:
 *
 * - visitar /checkout/success nunca vacía nada por sí solo;
 * - un pago pendiente conserva el registro; uno rechazado/cancelado/vencido lo
 *   descarta sin tocar el carrito;
 * - lo agregado después de iniciar la compra (otros productos o más unidades
 *   del mismo) queda en el carrito;
 * - aplicar es idempotente: `appliedAt` marca que el carrito guardado ya se
 *   descontó. Una pestaña cuyo carrito se cargó ANTES de esa marca también lo
 *   descuenta (una sola vez); una que lo cargó después, no.
 *
 * Funciones puras (sin React, red ni storage) para testearlas con node --test.
 */

import type { CartItem } from "./cart-items.ts"

export interface TrackedPurchase {
  orderId: number
  /** Token firmado del pedido de invitado (prueba de posesión); null con sesión. */
  guestToken: string | null
  /** Identidad de checkout comprometida con el pedido: se renueva al confirmarse. */
  sessionId: string | null
  createdAt: number
  /** Cuándo se descontó del carrito guardado; null mientras no se confirmó. */
  appliedAt: number | null
}

/** Línea comprada según el servidor (orden_items del pedido pagado). */
export interface PurchasedLine {
  productId: number
  variantId: number | null
  conditionedStockId: string | null
  quantity: number
}

/** Respuesta del servidor por pedido. `unknown`: no existe o no es de quien pregunta. */
export type PurchaseCheckStatus = "paid" | "pending" | "void" | "unknown"

export interface PurchaseCheckResult {
  orderId: number
  status: PurchaseCheckStatus
  items?: PurchasedLine[]
}

export const MAX_TRACKED_PURCHASES = 10
/** Un pedido sin confirmar después de esto deja de seguirse (MP y transferencia vencen antes). */
export const TRACKED_PURCHASE_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** Lo ya aplicado se conserva un tiempo para que otras pestañas abiertas también lo descuenten. */
export const APPLIED_PURCHASE_RETENTION_MS = 2 * 24 * 60 * 60 * 1000

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const positiveInteger = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null

const shortText = (value: unknown, max: number) =>
  typeof value === "string" && value.length > 0 && value.length <= max ? value : null

const timestamp = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null

/** Lee la lista guardada descartando todo lo inválido (nunca lanza). */
export function parseTrackedPurchases(raw: string | null | undefined): TrackedPurchase[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const seen = new Set<number>()
  const list: TrackedPurchase[] = []
  for (const entry of parsed) {
    if (!isRecord(entry)) continue
    const orderId = positiveInteger(entry.orderId)
    const createdAt = timestamp(entry.createdAt)
    if (!orderId || !createdAt || seen.has(orderId)) continue
    seen.add(orderId)
    list.push({
      orderId,
      guestToken: shortText(entry.guestToken, 4_096),
      sessionId: shortText(entry.sessionId, 200),
      createdAt,
      appliedAt: timestamp(entry.appliedAt),
    })
  }
  return list.slice(-MAX_TRACKED_PURCHASES)
}

/** Agrega (o reemplaza) el pedido recién creado; conserva los más recientes. */
export function registerTrackedPurchase(
  list: readonly TrackedPurchase[],
  purchase: { orderId: number; guestToken?: string | null; sessionId?: string | null },
  now: number,
): TrackedPurchase[] {
  const orderId = positiveInteger(purchase.orderId)
  if (!orderId) return [...list]
  const entry: TrackedPurchase = {
    orderId,
    guestToken: shortText(purchase.guestToken, 4_096),
    sessionId: shortText(purchase.sessionId, 200),
    createdAt: now,
    appliedAt: null,
  }
  return [...list.filter((item) => item.orderId !== orderId), entry].slice(-MAX_TRACKED_PURCHASES)
}

/** Quita lo vencido sin confirmar y lo aplicado hace demasiado. */
export function pruneTrackedPurchases(list: readonly TrackedPurchase[], now: number): TrackedPurchase[] {
  return list.filter((item) =>
    item.appliedAt === null
      ? now - item.createdAt < TRACKED_PURCHASE_TTL_MS
      : now - item.appliedAt < APPLIED_PURCHASE_RETENTION_MS)
}

/**
 * ¿Esta pestaña tiene que descontar la compra confirmada?
 * - nunca aplicada: sí;
 * - aplicada en otra pestaña después de que esta cargó su carrito: sí, una vez;
 * - aplicada antes de cargar el carrito (ya viene descontado) o ya aplicada acá: no.
 */
export function shouldApplyPurchaseInTab(
  purchase: Pick<TrackedPurchase, "orderId" | "appliedAt">,
  cartLoadedAt: number,
  appliedInTab: ReadonlySet<number>,
) {
  if (appliedInTab.has(purchase.orderId)) return false
  return purchase.appliedAt === null || purchase.appliedAt > cartLoadedAt
}

const sameLine = (item: CartItem, line: PurchasedLine) =>
  item.product.id === line.productId &&
  (item.variantId ?? null) === (line.variantId ?? null) &&
  (item.conditionedStockId ?? null) === (line.conditionedStockId ?? null)

/**
 * Descuenta del carrito exactamente lo comprado: por línea (producto +
 * variante + acondicionado), restando cantidades. Lo que no está en la compra,
 * o las unidades agregadas de más, se conservan. Sin cambios devuelve la misma
 * referencia.
 */
export function removePurchasedLines(cart: CartItem[], lines: readonly PurchasedLine[]): CartItem[] {
  const remaining = lines
    .filter((line) => positiveInteger(line.productId) && positiveInteger(line.quantity))
    .map((line) => ({ ...line }))
  if (!remaining.length) return cart
  let changed = false
  const next: CartItem[] = []
  for (const item of cart) {
    let quantity = item.quantity
    for (const line of remaining) {
      if (quantity <= 0 || line.quantity <= 0 || !sameLine(item, line)) continue
      const taken = Math.min(quantity, line.quantity)
      quantity -= taken
      line.quantity -= taken
    }
    if (quantity === item.quantity) next.push(item)
    else {
      changed = true
      if (quantity > 0) next.push({ ...item, quantity })
    }
  }
  return changed ? next : cart
}

/** Estado de una compra para el carrito, con la evidencia del servidor. */
export interface PurchaseOrderFacts {
  estado?: string | null
  cancelled_at?: string | null
  financial_status?: string | null
  paid?: boolean
}

const VOID_FINANCIAL_STATUSES = ["cancelled", "refund_pending", "refunded", "cancellation_requested"]

/**
 * `paid` sólo con evidencia real de pago (la calcula el servidor con
 * hasConfirmedPaymentEvidence). Cancelado, vencido o reintegrado sin pago
 * confirmado: `void` (el carrito no se toca). El resto sigue `pending`.
 */
export function classifyPurchaseOrder(order: PurchaseOrderFacts): Exclude<PurchaseCheckStatus, "unknown"> {
  if (order.paid) return "paid"
  if (order.estado === "cancelado" || order.cancelled_at || VOID_FINANCIAL_STATUSES.includes(order.financial_status ?? "")) {
    return "void"
  }
  return "pending"
}

/** Normaliza la respuesta del servidor (nunca confía en su forma). */
export function parsePurchaseCheckResults(value: unknown): PurchaseCheckResult[] {
  if (!isRecord(value) || !Array.isArray(value.orders)) return []
  const results: PurchaseCheckResult[] = []
  for (const entry of value.orders) {
    if (!isRecord(entry)) continue
    const orderId = positiveInteger(entry.orderId)
    const status = entry.status
    if (!orderId || (status !== "paid" && status !== "pending" && status !== "void" && status !== "unknown")) continue
    if (status !== "paid") {
      results.push({ orderId, status })
      continue
    }
    if (!Array.isArray(entry.items)) continue
    const items: PurchasedLine[] = []
    for (const raw of entry.items) {
      if (!isRecord(raw)) continue
      const productId = positiveInteger(raw.productId)
      const quantity = positiveInteger(raw.quantity)
      if (!productId || !quantity) continue
      items.push({
        productId,
        quantity,
        variantId: positiveInteger(raw.variantId),
        conditionedStockId: shortText(raw.conditionedStockId, 200),
      })
    }
    results.push({ orderId, status, items })
  }
  return results
}
