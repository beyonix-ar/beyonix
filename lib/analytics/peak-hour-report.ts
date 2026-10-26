import type { AnalyticsDateRange } from "./product-view-report.ts"

/**
 * Admin > Analítica > Horario pico de visualizaciones. La agregación por hora
 * de Argentina la hace `admin_product_view_peak_hour` en SQL; acá sólo se
 * arma el reporte para la card.
 */

export interface PeakHourReport {
  range: AnalyticsDateRange
  totalViews: number
  /** `null` si el período no tiene visualizaciones. */
  peak: {
    /** Hora de inicio de la franja (0–23, hora de Argentina). */
    hour: number
    views: number
    /** Participación en las visualizaciones del período, 0–100. */
    sharePercent: number
  } | null
}

export interface PeakHourRow {
  hour: number
  views: number
  totalViews: number
}

export function buildPeakHourReport(range: AnalyticsDateRange, row: PeakHourRow | null): PeakHourReport {
  const valid =
    row &&
    Number.isInteger(row.hour) &&
    row.hour >= 0 &&
    row.hour <= 23 &&
    Number.isFinite(row.views) &&
    row.views > 0 &&
    Number.isFinite(row.totalViews) &&
    row.totalViews >= row.views
  if (!valid) return { range, totalViews: 0, peak: null }

  return {
    range,
    totalViews: row.totalViews,
    peak: { hour: row.hour, views: row.views, sharePercent: (row.views / row.totalViews) * 100 },
  }
}

const pad = (hour: number) => `${String(hour).padStart(2, "0")}:00`

/** 14 → "14:00 – 15:00"; 23 → "23:00 – 00:00". */
export function formatHourRange(hour: number) {
  return `${pad(hour)} – ${pad((hour + 1) % 24)}`
}
