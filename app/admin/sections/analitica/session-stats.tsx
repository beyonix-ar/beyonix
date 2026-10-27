"use client"

import type { PeriodComparisonReport } from "@/lib/analytics/period-comparison"
import type { AnalyticsDateRange } from "@/lib/analytics/product-view-report"
import { formatViewsPerSession, type SessionStatsReport } from "@/lib/analytics/session-stats-report"

import { PeriodChange } from "./period-change"
import { AnalyticsStatCard } from "./stat-card"
import { useAnalyticsReport, type AnalyticsReportState } from "./use-analytics-report"

const viewsFormatter = new Intl.NumberFormat("es-AR")

const SESSIONS_HELP =
  "Sesiones de navegación que abrieron al menos un producto en el período. Cada sesión cuenta una vez, sin importar cuántos productos vio. Una sesión termina tras 30 minutos sin actividad: no son personas ni visitas totales del sitio. La variación se compara con el período inmediatamente anterior de la misma duración."

export function useSessionStatsReport(range: AnalyticsDateRange | null, rangeKey: string | null) {
  return useAnalyticsReport<SessionStatsReport>(
    "/api/admin/analytics/session-stats",
    "No se pudieron cargar las sesiones con visualizaciones.",
    range,
    rangeKey,
  )
}

/**
 * "Sesiones con visualizaciones" y "Visualizaciones por sesión". Sin vistas
 * en el período: 0 y "—" (nunca 0/0). Un refresh fallido conserva el último
 * dato válido; otro período nunca muestra el anterior.
 */
export function SessionStatsCards({
  report,
  loadError,
  comparison,
}: AnalyticsReportState<SessionStatsReport> & { comparison: PeriodComparisonReport | null }) {
  return (
    <>
      <AnalyticsStatCard
        className="admin-analytics-sessions xl:col-span-3"
        label="Sesiones con visualizaciones"
        help={SESSIONS_HELP}
        value={report ? viewsFormatter.format(report.sessions) : null}
        detail="Sesiones que vieron al menos un producto"
        loadError={loadError}
        change={<PeriodChange comparison={comparison} metric="sessions" />}
      />
      <AnalyticsStatCard
        className="admin-analytics-views-per-session xl:col-span-3"
        label="Visualizaciones por sesión"
        value={report ? formatViewsPerSession(report.viewsPerSession) : null}
        detail="Promedio por sesión"
        loadError={loadError}
        change={<PeriodChange comparison={comparison} metric="viewsPerSession" />}
      />
    </>
  )
}
