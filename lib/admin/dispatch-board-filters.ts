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

export function defaultDispatchFilters(tab: DispatchBoardTab, today = dispatchToday()): DispatchBoardFilters {
  return { search: "", dateMode: tab === "ready" || tab === "delivered" ? "today" : "all", dateFrom: tab === "ready" || tab === "delivered" ? today : "", dateTo: tab === "ready" || tab === "delivered" ? today : "", batch: "", operator: "", state: "", quantityKind: tab === "armado" || tab === "ready" ? "units" : "orders", quantityMin: "", quantityMax: "", sku: "", tracking: "", hasCancelled: "", hasRemoved: "", invoiced: "" }
}

export function dispatchFilterParams(tab: DispatchBoardTab, filters: DispatchBoardFilters, page: number) {
  const params = new URLSearchParams({ tab, page: String(page) })
  if ((tab === "ready" || tab === "delivered") && !filters.dateFrom && !filters.dateTo) params.set("allDates", "true")
  for (const [key, value] of Object.entries(filters)) if (key !== "dateMode" && value.trim()) params.set(key, value.trim())
  return params.toString()
}

export function dispatchPageCount(total: number) {
  return Math.max(1, Math.ceil(total / DISPATCH_BOARD_PAGE_SIZE))
}
