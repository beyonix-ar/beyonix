import { touchAnalyticsSession } from "./analytics-session.ts"
import { getBrowserAnalyticsStore, type AnalyticsStore } from "./analytics-storage.ts"
import { PRODUCT_VIEW_DEDUP_WINDOW_MS } from "./events.ts"

/**
 * Estado de envío de `product_view` por producto dentro de la sesión. Sólo
 * evita requests inútiles; la base sigue siendo la autoridad de la
 * deduplicación (un reintento de algo que sí llegó vuelve "duplicate").
 *
 *   pending: enviado, sin respuesta todavía (no se reenvía mientras tanto).
 *   sent:    el servidor respondió; no se reenvía durante la ventana de 30 min.
 *   failed:  red caída, timeout o error del servidor; se reintenta la próxima
 *            vez que el producto se abra, nunca antes de RETRY_DELAY_MS. Sin
 *            reintentos automáticos ni timers.
 */

export const PRODUCT_VIEWS_STORAGE_KEY = "beyonix-analytics-product-views"
/** Un envío sin respuesta tras este tiempo (pestaña cerrada, request perdido) se considera fallido. */
export const PRODUCT_VIEW_PENDING_TIMEOUT_MS = 20_000
export const PRODUCT_VIEW_RETRY_DELAY_MS = 30_000

type ProductViewStatus = "pending" | "sent" | "failed"

interface ProductViewEntry {
  status: ProductViewStatus
  at: number
}

interface ProductViewState {
  sessionId: string
  entries: Record<string, ProductViewEntry>
}

function isProductViewState(value: unknown): value is ProductViewState {
  if (!value || typeof value !== "object") return false
  const state = value as Partial<ProductViewState>
  return typeof state.sessionId === "string" && Boolean(state.entries) && typeof state.entries === "object"
}

function isEntry(value: unknown): value is ProductViewEntry {
  if (!value || typeof value !== "object") return false
  const entry = value as Partial<ProductViewEntry>
  return (entry.status === "pending" || entry.status === "sent" || entry.status === "failed") && typeof entry.at === "number"
}

function canSend(entry: ProductViewEntry, now: number) {
  const elapsed = now - entry.at
  if (entry.status === "sent") return elapsed >= PRODUCT_VIEW_DEDUP_WINDOW_MS
  if (entry.status === "pending") return elapsed >= PRODUCT_VIEW_PENDING_TIMEOUT_MS
  return elapsed >= PRODUCT_VIEW_RETRY_DELAY_MS
}

function currentEntries(state: ProductViewState | null, sessionId: string, now: number) {
  const entries: Record<string, ProductViewEntry> = {}
  if (state?.sessionId !== sessionId) return entries
  for (const [key, entry] of Object.entries(state.entries)) {
    if (isEntry(entry) && now - entry.at < PRODUCT_VIEW_DEDUP_WINDOW_MS) entries[key] = entry
  }
  return entries
}

/**
 * Abrir un producto es actividad: renueva la sesión. Devuelve con qué sesión
 * enviar la vista, o `null` si no corresponde enviarla ahora.
 */
export function claimProductView(
  productId: number,
  now: number = Date.now(),
  store: AnalyticsStore = getBrowserAnalyticsStore(),
): { sessionId: string } | null {
  const session = touchAnalyticsSession(now, store)
  if (!session) return null

  const entries = currentEntries(store.read(PRODUCT_VIEWS_STORAGE_KEY, isProductViewState), session.id, now)
  const key = String(productId)
  const entry = entries[key]
  const send = !entry || canSend(entry, now)
  if (send) entries[key] = { status: "pending", at: now }

  store.write(PRODUCT_VIEWS_STORAGE_KEY, { sessionId: session.id, entries })
  return send ? { sessionId: session.id } : null
}

/** Resultado del envío reclamado con `claimProductView`. */
export function settleProductView(
  productId: number,
  sessionId: string,
  delivered: boolean,
  now: number = Date.now(),
  store: AnalyticsStore = getBrowserAnalyticsStore(),
) {
  const state = store.read(PRODUCT_VIEWS_STORAGE_KEY, isProductViewState)
  if (state?.sessionId !== sessionId) return
  const key = String(productId)
  if (state.entries[key]?.status !== "pending") return
  state.entries[key] = { status: delivered ? "sent" : "failed", at: now }
  store.write(PRODUCT_VIEWS_STORAGE_KEY, state)
}
