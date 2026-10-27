import type { AnalyticsDateRange } from "./product-view-report.ts"

/**
 * Admin > Analítica > sesiones con visualizaciones. Los números base
 * (vistas y session_id distintos) los cuenta `admin_product_view_session_stats`
 * en SQL; acá se validan y se calcula el promedio para la UI.
 */
export interface SessionStatsReport {
  range: AnalyticsDateRange
  totalViews: number
  /** session_id distintos con al menos un product_view en el período. */
  sessions: number
  /** Visualizaciones / sesiones; `null` sin sesiones (nunca 0/0). */
  viewsPerSession: number | null
}

/** Fila de la RPC, o `null` si no devolvió ninguna. Datos incoherentes → período sin vistas. */
export function buildSessionStatsReport(range: AnalyticsDateRange, row: { totalViews: number; sessions: number } | null): SessionStatsReport {
  const valid =
    row &&
    Number.isInteger(row.totalViews) &&
    Number.isInteger(row.sessions) &&
    row.sessions >= 0 &&
    // Cada sesión contada vio al menos un producto, y sin sesiones no hay vistas.
    row.totalViews >= row.sessions &&
    (row.sessions > 0 || row.totalViews === 0)
  if (!valid || row.sessions === 0) return { range, totalViews: 0, sessions: 0, viewsPerSession: null }
  return { range, totalViews: row.totalViews, sessions: row.sessions, viewsPerSession: row.totalViews / row.sessions }
}

const perSessionFormatter = new Intl.NumberFormat("es-AR", { maximumFractionDigits: 1 })

/** 2.5 → "2,5"; 5 → "5"; 10/3 → "3,3"; sin sesiones → "—". */
export function formatViewsPerSession(value: number | null) {
  return value === null ? "—" : perSessionFormatter.format(value)
}
