export type DispatchBoardTab = "armado" | "ready" | "open" | "delivered"
export type DispatchBoardFilters = {
  search: string; dateMode: "today" | "day" | "range" | "all"; dateFrom: string; dateTo: string; batch: string; operator: string
  state: string; quantityKind: string; quantityMin: string; quantityMax: string
  sku: string; tracking: string; hasCancelled: string; hasRemoved: string; invoiced: string
}

export const DISPATCH_BOARD_PAGE_SIZE = 20

export function dispatchToday(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires", year: "numeric", month: "2-digit", day: "2-digit" }).format(date)
}

/**
 * Pendientes, Confirmados y Bultos son trabajo abierto: arrancan sin fecha para
 * que nada desaparezca por antigüedad (la fecha queda para buscar a mano).
 * Sólo Entregados, que es historial, arranca en hoy.
 */
export function defaultDispatchFilters(tab: DispatchBoardTab, today = dispatchToday()): DispatchBoardFilters {
  const history = tab === "delivered"
  return { search: "", dateMode: history ? "today" : "all", dateFrom: history ? today : "", dateTo: history ? today : "", batch: "", operator: "", state: "", quantityKind: tab === "armado" || tab === "ready" ? "units" : "orders", quantityMin: "", quantityMax: "", sku: "", tracking: "", hasCancelled: "", hasRemoved: "", invoiced: "" }
}

export function dispatchFilterParams(tab: DispatchBoardTab, filters: DispatchBoardFilters, page: number) {
  const params = new URLSearchParams({ tab, page: String(page) })
  if (tab === "delivered" && !filters.dateFrom && !filters.dateTo) params.set("allDates", "true")
  for (const [key, value] of Object.entries(filters)) if (key !== "dateMode" && value.trim()) params.set(key, value.trim())
  return params.toString()
}

/** Fecha que aplica la API cuando no llega ninguna: sólo Entregados (historial) se limita a hoy. */
export function dispatchDefaultDate(tab: DispatchBoardTab, allDates: boolean, today = dispatchToday()) {
  return tab === "delivered" && !allDates ? today : null
}

export function dispatchPageCount(total: number) {
  return Math.max(1, Math.ceil(total / DISPATCH_BOARD_PAGE_SIZE))
}
