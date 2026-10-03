export type FiscalKind = "invoice" | "credit_note"
export type FiscalPeriod = "today" | "month" | "all"

export interface FiscalDocument {
  kind: FiscalKind
  id: string
  order_id: number
  point: number
  number: number
  display_number: string
  client: string | null
  document: string | null
  issued_at: string
  day: string
  amount: number
  cae: string
  status: string
  environment: string | null
  reason: string | null
  original_point: number | null
  original_number: number | null
}

export const FISCAL_PAGE_SIZE = 30
export const FISCAL_EXPORT_LIMIT = 250

export function argentinaToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

export function fiscalMonthBounds(year: number, month: number) {
  if (!Number.isInteger(year) || year < 2000 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error("Mes fiscal inválido.")
  }
  const from = `${year}-${String(month).padStart(2, "0")}-01`
  const nextYear = month === 12 ? year + 1 : year
  const nextMonth = month === 12 ? 1 : month + 1
  const to = `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`
  return { from, to }
}

export function fiscalDayBounds(day: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T12:00:00Z`))) {
    throw new Error("Fecha fiscal inválida.")
  }
  const next = new Date(`${day}T12:00:00Z`)
  if (next.toISOString().slice(0, 10) !== day) throw new Error("Fecha fiscal inválida.")
  next.setUTCDate(next.getUTCDate() + 1)
  return { from: day, to: next.toISOString().slice(0, 10) }
}

export function fiscalPeriodBounds(period: FiscalPeriod, year: number, month: number, now = new Date()) {
  if (period === "today") return fiscalDayBounds(argentinaToday(now))
  if (period === "month") return fiscalMonthBounds(year, month)
  return { from: null, to: null }
}

export function fiscalZipName(kind: FiscalKind, days: string[]) {
  const prefix = kind === "invoice" ? "facturas" : "notas-credito"
  const unique = [...new Set(days)]
  if (unique.length === 1) return `${prefix}-beyonix-${unique[0]}.zip`
  const months = [...new Set(days.map((day) => day.slice(0, 7)))]
  if (months.length === 1) return `${prefix}-beyonix-${months[0]}.zip`
  return `${prefix}-beyonix-seleccion.zip`
}
