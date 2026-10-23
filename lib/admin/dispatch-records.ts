import { orderCode } from "./dispatch"
import { dispatchBatchName } from "./dispatch-queue"

/**
 * Tabla única de Despachos (search_dispatch_records): cada registro es un
 * pedido sin Bulto o un Bulto completo, nunca ambos. El id interno sólo se usa
 * para abrir el detalle; en pantalla se ve BX-xxxx o Bulto - xxxx.
 */
/** Sólo estados respaldados por datos: un estado "Anulado" no existe en la base. */
export type DispatchRecordState = "P" | "C" | "E" | "X"
export type DispatchRecord = {
  kind: "order" | "batch"
  id: number
  code: string | null
  displayNumber: number | null
  state: DispatchRecordState
  at: string | null
  actorId: string | null
  actorName: string | null
  units: number
  /** null: el rol no ve importes. */
  total: number | null
  orderCount: number
  /** Pedido confirmado que puede entrar a un Bulto nuevo. */
  selectable: boolean
}
export type DispatchUser = { id: string; name: string }

export const DISPATCH_RECORD_STATES: Record<DispatchRecordState, { label: string; tone: "warning" | "success" | "info" | "danger" }> = {
  P: { label: "Pendiente", tone: "warning" },
  C: { label: "Confirmado", tone: "success" },
  // Entregado por BEYONIX al transportista; nunca "entregado al cliente".
  E: { label: "Entregado", tone: "info" },
  X: { label: "Cancelado", tone: "danger" },
}
const STATES = Object.keys(DISPATCH_RECORD_STATES) as DispatchRecordState[]
export const isDispatchRecordState = (value: unknown): value is DispatchRecordState => STATES.some((state) => state === value)

export const DISPATCH_RECORDS_PAGE_SIZE = 20

export function dispatchToday(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires", year: "numeric", month: "2-digit", day: "2-digit" }).format(date)
}

/**
 * Fecha vacía = todas las fechas. La fecha por defecto (hoy) sólo filtra lo
 * resuelto (Entregado, Cancelado): Pendiente y Confirmado siguen visibles hasta
 * resolverse. Una fecha elegida a mano (`manualDate`) filtra todo.
 */
export type DispatchRecordFilters = { date: string; manualDate: boolean; order: string; batch: string; user: string; state: string }
const TEXT_FILTERS = ["date", "order", "batch", "user", "state"] as const

export function defaultDispatchRecordFilters(today = dispatchToday()): DispatchRecordFilters {
  return { date: today, manualDate: false, order: "", batch: "", user: "", state: "" }
}

/** Limpiar: todo vacío, incluida la fecha (sin fecha = todas las fechas). */
export function clearedDispatchRecordFilters(): DispatchRecordFilters {
  return { date: "", manualDate: true, order: "", batch: "", user: "", state: "" }
}

export function dispatchRecordParams(filters: DispatchRecordFilters, page: number) {
  const params = new URLSearchParams({ page: String(page) })
  for (const key of TEXT_FILTERS) if (filters[key].trim()) params.set(key, filters[key].trim())
  if (filters.date.trim() && !filters.manualDate) params.set("openAllDates", "true")
  return params.toString()
}

export function dispatchPageCount(total: number) {
  return Math.max(1, Math.ceil(total / DISPATCH_RECORDS_PAGE_SIZE))
}

export const dispatchRecordOrderLabel = (record: Pick<DispatchRecord, "kind" | "id">) => record.kind === "order" ? orderCode(record.id) : "—"
export const dispatchRecordBatchLabel = (record: Pick<DispatchRecord, "kind" | "id" | "displayNumber">) =>
  record.kind === "batch" ? dispatchBatchName({ id: record.id, display_number: record.displayNumber }) : "—"

/** Filtros y página guardados en la sesión del navegador. */
export type DispatchRecordsView = { filters: DispatchRecordFilters; page: number; today: string }
export const DISPATCH_VIEW_KEY = "beyonix:dispatch-records-view"

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

/** Restaura lo guardado descartando lo inválido; lo guardado otro día vuelve a hoy. */
export function restoreDispatchRecordsView(raw: string | null, today = dispatchToday()): DispatchRecordsView {
  const view: DispatchRecordsView = { filters: defaultDispatchRecordFilters(today), page: 1, today }
  let parsed: unknown = null
  try { parsed = raw ? JSON.parse(raw) : null } catch { return view }
  if (!isRecord(parsed) || parsed.today !== today || !isRecord(parsed.filters)) return view
  const stored = parsed.filters
  for (const key of TEXT_FILTERS) {
    const value = stored[key]
    if (typeof value === "string" && value.length <= 80) view.filters[key] = value
  }
  if (typeof stored.manualDate === "boolean") view.filters.manualDate = stored.manualDate
  if (view.filters.date && !/^\d{4}-\d{2}-\d{2}$/.test(view.filters.date)) view.filters.date = today
  if (view.filters.state && !isDispatchRecordState(view.filters.state)) view.filters.state = ""
  if (typeof parsed.page === "number" && Number.isSafeInteger(parsed.page) && parsed.page >= 1 && parsed.page <= 100000) view.page = parsed.page
  return view
}
