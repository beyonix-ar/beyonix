import type { AnalyticsDateRange } from "./product-view-report.ts"

/**
 * Admin > Analítica > visualizaciones por horario y por día de la semana. La
 * agregación en hora de Argentina la hacen las RPC en SQL
 * (`admin_product_view_peak_hour`, `admin_product_views_by_weekday` y
 * `admin_product_view_peak_weekday`, que elige el ganador de esa misma
 * distribución); acá se validan y se arman los reportes para la UI.
 */

/** Fila de una RPC de pico: franja/día ganador, sus visualizaciones y el total del período. */
export interface PeakViewsRow {
  bucket: number
  views: number
  totalViews: number
}

interface PeakViews {
  views: number
  /** Participación en las visualizaciones del período, 0–100. */
  sharePercent: number
}

export interface PeakHourReport {
  range: AnalyticsDateRange
  totalViews: number
  /** `null` si el período no tiene visualizaciones. */
  peak: (PeakViews & {
    /** Hora de inicio de la franja (0–23, hora de Argentina). */
    hour: number
  }) | null
}

export interface PeakWeekdayReport {
  range: AnalyticsDateRange
  totalViews: number
  /** `null` si el período no tiene visualizaciones. */
  peak: (PeakViews & {
    /** Día ISO en Argentina: 1 = lunes … 7 = domingo. */
    weekday: number
  }) | null
}

/** Ganador coherente con el total del período, o `null` (sin datos o datos inválidos). */
function resolvePeak(row: PeakViewsRow | null, min: number, max: number): (PeakViews & { bucket: number; totalViews: number }) | null {
  const valid =
    row &&
    Number.isInteger(row.bucket) &&
    row.bucket >= min &&
    row.bucket <= max &&
    Number.isFinite(row.views) &&
    row.views > 0 &&
    Number.isFinite(row.totalViews) &&
    row.totalViews >= row.views
  if (!valid) return null
  return { bucket: row.bucket, views: row.views, totalViews: row.totalViews, sharePercent: (row.views / row.totalViews) * 100 }
}

export function buildPeakHourReport(range: AnalyticsDateRange, row: PeakViewsRow | null): PeakHourReport {
  const peak = resolvePeak(row, 0, 23)
  if (!peak) return { range, totalViews: 0, peak: null }
  return { range, totalViews: peak.totalViews, peak: { hour: peak.bucket, views: peak.views, sharePercent: peak.sharePercent } }
}

export function buildPeakWeekdayReport(range: AnalyticsDateRange, row: PeakViewsRow | null): PeakWeekdayReport {
  const peak = resolvePeak(row, 1, 7)
  if (!peak) return { range, totalViews: 0, peak: null }
  return { range, totalViews: peak.totalViews, peak: { weekday: peak.bucket, views: peak.views, sharePercent: peak.sharePercent } }
}

const pad = (hour: number) => `${String(hour).padStart(2, "0")}:00`

/** 14 → "14:00 – 15:00"; 23 → "23:00 – 00:00". */
export function formatHourRange(hour: number) {
  return `${pad(hour)} – ${pad((hour + 1) % 24)}`
}

const WEEKDAY_NAMES = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"] as const
const WEEKDAY_SHORT_NAMES = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"] as const

/** Día ISO (1 = lunes … 7 = domingo) → "Lunes" … "Domingo". */
export function formatWeekday(weekday: number) {
  return WEEKDAY_NAMES[weekday - 1]
}

/** Día ISO (1 = lunes … 7 = domingo) → "Lun" … "Dom". */
export function formatWeekdayShort(weekday: number) {
  return WEEKDAY_SHORT_NAMES[weekday - 1]
}

/** Visualizaciones de un día de la semana: suma de todas sus fechas dentro del período. */
export interface WeekdayViews {
  /** Día ISO en Argentina: 1 = lunes … 7 = domingo. */
  weekday: number
  views: number
  /** Participación en las visualizaciones del período, 0–100 (0 si el período no tiene vistas). */
  sharePercent: number
}

export interface WeekdayViewsReport {
  range: AnalyticsDateRange
  totalViews: number
  /** Siempre los 7 días, de lunes a domingo; los días sin vistas valen 0. */
  days: WeekdayViews[]
}

/**
 * `admin_product_views_by_weekday` sólo devuelve los días con vistas; acá se
 * completan los 7 (lunes a domingo) con 0 y se descartan filas inválidas.
 */
export function buildWeekdayViewsReport(range: AnalyticsDateRange, rows: { weekday: number; views: number }[]): WeekdayViewsReport {
  const views = new Map<number, number>()
  for (const row of rows) {
    if (Number.isInteger(row.weekday) && row.weekday >= 1 && row.weekday <= 7 && Number.isFinite(row.views) && row.views > 0) {
      views.set(row.weekday, row.views)
    }
  }
  const totalViews = Array.from(views.values()).reduce((sum, count) => sum + count, 0)
  const days = WEEKDAY_NAMES.map((_, index) => {
    const count = views.get(index + 1) ?? 0
    return { weekday: index + 1, views: count, sharePercent: totalViews > 0 ? (count / totalViews) * 100 : 0 }
  })
  return { range, totalViews, days }
}
