import type { DispatchStage } from "./dispatch"
import { defaultDispatchFilters, dispatchToday, type DispatchBoardFilters, type DispatchBoardTab } from "./dispatch-board-filters"

export const DISPATCH_PATH = "/admin/despachos"
const TABS: readonly DispatchBoardTab[] = ["armado", "ready", "open", "delivered"]

/**
 * Lo abierto en Despachos vive en la URL (?tab, ?order, ?batch): refrescar,
 * volver o abrir otra pestaña del navegador no pierde el pedido ni el Bulto.
 * `tab` null = enlace directo sin pestaña (p. ej. desde Pedidos).
 */
export type DispatchLocation = { tab: DispatchBoardTab | null; orderId: number | null; batchId: number | null }

const isTab = (value: string | null | undefined): value is DispatchBoardTab => TABS.some((tab) => tab === value)

function positiveId(value: string | null | undefined) {
  if (!value || !/^\d{1,12}$/.test(value)) return null
  const id = Number(value)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

export function parseDispatchLocation(input: { tab?: string | null; order?: string | null; batch?: string | null }): DispatchLocation {
  const orderId = positiveId(input.order)
  return { tab: isTab(input.tab) ? input.tab : null, orderId, batchId: orderId ? null : positiveId(input.batch) }
}

export function dispatchLocationFromSearch(search: string): DispatchLocation {
  const params = new URLSearchParams(search)
  return parseDispatchLocation({ tab: params.get("tab"), order: params.get("order"), batch: params.get("batch") })
}

export function dispatchLocationHref(location: DispatchLocation) {
  const params = new URLSearchParams()
  if (location.tab) params.set("tab", location.tab)
  if (location.orderId) params.set("order", String(location.orderId))
  else if (location.batchId) params.set("batch", String(location.batchId))
  const query = params.toString()
  return query ? `${DISPATCH_PATH}?${query}` : DISPATCH_PATH
}

/** Pestaña de la cola donde está un pedido según su etapa. */
export function dispatchTabForStage(stage: DispatchStage): DispatchBoardTab {
  if (stage === "label" || stage === "ready") return "ready"
  if (stage === "in_batch" || stage === "batch_closed") return "open"
  if (stage === "handed_over") return "delivered"
  return "armado"
}

/** Filtros y página de cada pestaña: se conservan en la sesión del navegador. */
export type DispatchBoardView = { filters: Record<DispatchBoardTab, DispatchBoardFilters>; pages: Record<DispatchBoardTab, number> }

export const DISPATCH_VIEW_KEY = "beyonix:dispatch-board-view"

export function defaultDispatchBoardView(today = dispatchToday()): DispatchBoardView {
  return {
    filters: { armado: defaultDispatchFilters("armado", today), ready: defaultDispatchFilters("ready", today), open: defaultDispatchFilters("open", today), delivered: defaultDispatchFilters("delivered", today) },
    pages: { armado: 1, ready: 1, open: 1, delivered: 1 },
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const DATE_MODES: readonly DispatchBoardFilters["dateMode"][] = ["today", "day", "range", "all"]

/**
 * Restaura lo guardado descartando lo inválido. "Hoy" se recalcula: un filtro
 * guardado ayer nunca queda fijo en la fecha vieja.
 */
export function restoreDispatchBoardView(raw: string | null, today = dispatchToday()): DispatchBoardView {
  const view = defaultDispatchBoardView(today)
  let parsed: unknown = null
  try { parsed = raw ? JSON.parse(raw) : null } catch { return view }
  if (!isRecord(parsed)) return view
  const filters = isRecord(parsed.filters) ? parsed.filters : {}
  const pages = isRecord(parsed.pages) ? parsed.pages : {}
  for (const tab of TABS) {
    const stored = filters[tab]
    if (isRecord(stored)) {
      const next: DispatchBoardFilters = { ...view.filters[tab] }
      for (const key of Object.keys(next) as (keyof DispatchBoardFilters)[]) {
        const value = stored[key]
        if (typeof value !== "string" || value.length > 120) continue
        if (key === "dateMode") { const mode = DATE_MODES.find((item) => item === value); if (mode) next.dateMode = mode }
        else next[key] = value
      }
      if (next.dateMode === "today") { next.dateFrom = today; next.dateTo = today }
      view.filters[tab] = next
    }
    const page = pages[tab]
    if (typeof page === "number" && Number.isSafeInteger(page) && page >= 1 && page <= 100000) view.pages[tab] = page
  }
  return view
}
