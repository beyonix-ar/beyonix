import { addDays, daysBetweenInclusive, isDateKey } from "../business/dashboard-sales-analytics.ts"

/**
 * Admin > Analítica > Productos más vistos: períodos y armado del reporte a
 * partir de las filas agregadas por `admin_product_view_stats`. Fechas
 * `YYYY-MM-DD` en hora de Argentina, la misma convención del Dashboard.
 */

export type AnalyticsPeriodPreset = "today" | "7d" | "30d" | "custom"

export const ANALYTICS_PERIOD_PRESETS: { value: AnalyticsPeriodPreset; label: string }[] = [
  { value: "today", label: "Hoy" },
  { value: "7d", label: "Últimos 7 días" },
  { value: "30d", label: "Últimos 30 días" },
  { value: "custom", label: "Personalizado" },
]

/** Tope del rango personalizado: un año (las consultas siempre van acotadas). */
export const ANALYTICS_MAX_RANGE_DAYS = 366

export interface AnalyticsDateRange {
  from: string
  to: string
}

export interface ProductViewStatsRow {
  productId: number
  name: string
  slug: string
  image: string | null
  /** Hoy tiene PDP pública (activo). Archivados y eliminados conservan sus vistas, sin enlace. */
  available: boolean
  views: number
}

export interface ProductViewRankingEntry extends ProductViewStatsRow {
  position: number
  /** Participación en las vistas totales del período, 0–100. */
  sharePercent: number
}

export interface ProductViewReport {
  range: AnalyticsDateRange
  totalViews: number
  productsViewed: number
  topProduct: ProductViewRankingEntry | null
  ranking: ProductViewRankingEntry[]
}

/** Fecha real de calendario: `isDateKey` deja pasar días normalizables como 2026-02-30. */
function isCalendarDateKey(value: string) {
  return isDateKey(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
}

export function isValidAnalyticsRange(range: AnalyticsDateRange) {
  return (
    isCalendarDateKey(range.from) &&
    isCalendarDateKey(range.to) &&
    range.from <= range.to &&
    daysBetweenInclusive(range) <= ANALYTICS_MAX_RANGE_DAYS
  )
}

/** Rango concreto del preset; `null` si el personalizado es inválido o incompleto. */
export function resolveAnalyticsPeriod(
  preset: AnalyticsPeriodPreset,
  todayKey: string,
  custom: AnalyticsDateRange,
): AnalyticsDateRange | null {
  switch (preset) {
    case "today":
      return { from: todayKey, to: todayKey }
    case "7d":
      return { from: addDays(todayKey, -6), to: todayKey }
    case "30d":
      return { from: addDays(todayKey, -29), to: todayKey }
    case "custom": {
      const range = { from: custom.from, to: custom.to || todayKey }
      return isValidAnalyticsRange(range) ? range : null
    }
  }
}

/**
 * Ranking por vistas (desempate por nombre, igual que la consulta). Sólo
 * productos con vistas: una fila con 0 nunca entra.
 */
export function buildProductViewReport(
  range: AnalyticsDateRange,
  rows: ProductViewStatsRow[],
): ProductViewReport {
  const viewed = rows
    .filter((row) => Number.isFinite(row.views) && row.views > 0)
    .sort((a, b) => b.views - a.views || a.name.localeCompare(b.name, "es") || a.productId - b.productId)
  const totalViews = viewed.reduce((total, row) => total + row.views, 0)
  const ranking = viewed.map((row, index) => ({
    ...row,
    position: index + 1,
    sharePercent: totalViews > 0 ? (row.views / totalViews) * 100 : 0,
  }))

  return {
    range,
    totalViews,
    productsViewed: ranking.length,
    topProduct: ranking[0] ?? null,
    ranking,
  }
}

const dayFormatter = new Intl.DateTimeFormat("es-AR", { timeZone: "UTC", day: "numeric", month: "short" })

/** "26 oct 2026" o "20 oct – 26 oct 2026". */
export function formatAnalyticsRange(range: AnalyticsDateRange) {
  const format = (key: string, withYear: boolean) => {
    const [year, month, day] = key.split("-").map(Number)
    const label = dayFormatter.format(new Date(Date.UTC(year, month - 1, day))).replaceAll(".", "")
    return withYear ? `${label} ${year}` : label
  }
  if (range.from === range.to) return format(range.from, true)
  const sameYear = range.from.slice(0, 4) === range.to.slice(0, 4)
  return `${format(range.from, !sameYear)} – ${format(range.to, true)}`
}

const shareFormatter = new Intl.NumberFormat("es-AR", { maximumFractionDigits: 1 })

/** 32 → "32%", 12,345 → "12,3%", menos de 0,1 → "<0,1%". */
export function formatSharePercent(value: number) {
  if (value > 0 && value < 0.05) return "<0,1%"
  return `${shareFormatter.format(value)}%`
}
