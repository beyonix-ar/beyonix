"use client"

import type { AnalyticsDateRange } from "@/lib/analytics/product-view-report"
import { formatViewsPerSession, type SessionStatsReport } from "@/lib/analytics/session-stats-report"

import { AdminHelpTip } from "../../components/admin-help-tip"
import { useAnalyticsReport, type AnalyticsReportState } from "./use-analytics-report"

const viewsFormatter = new Intl.NumberFormat("es-AR")

const SESSIONS_HELP =
  "Sesiones de navegación que abrieron al menos un producto en el período. Cada sesión cuenta una vez, sin importar cuántos productos vio. Una sesión termina tras 30 minutos sin actividad: no son personas ni visitas totales del sitio."

export function useSessionStatsReport(range: AnalyticsDateRange | null, rangeKey: string | null) {
  return useAnalyticsReport<SessionStatsReport>(
    "/api/admin/analytics/session-stats",
    "No se pudieron cargar las sesiones con visualizaciones.",
    range,
    rangeKey,
  )
}

interface SessionStatCardProps {
  className: string
  label: string
  help?: string
  /** Valor ya formateado; `null` mientras no hay reporte del período. */
  value: string | null
  detail: string
  loadError: string | null
}

function SessionStatCard({ className, label, help, value, detail, loadError }: SessionStatCardProps) {
  return (
    <div className={`admin-dashboard-kpi ${className} min-w-0 rounded-2xl border px-4 py-3 xl:col-span-3`} aria-busy={value === null && !loadError}>
      <p className="flex items-center gap-1 text-10px font-black uppercase tracking-widest text-white/52">
        {label}
        {help && <AdminHelpTip label={label} text={help} />}
      </p>
      <p className="mt-1 truncate text-2xl font-black tabular-nums text-white">{value ?? (loadError ? "—" : "…")}</p>
      <p className="mt-0.5 truncate text-11px text-white/52">{value === null && loadError ? loadError : detail}</p>
    </div>
  )
}

/**
 * "Sesiones con visualizaciones" y "Visualizaciones por sesión". Sin vistas
 * en el período: 0 y "—" (nunca 0/0). Un refresh fallido conserva el último
 * dato válido; otro período nunca muestra el anterior.
 */
export function SessionStatsCards({ report, loadError }: AnalyticsReportState<SessionStatsReport>) {
  return (
    <>
      <SessionStatCard
        className="admin-analytics-sessions"
        label="Sesiones con visualizaciones"
        help={SESSIONS_HELP}
        value={report ? viewsFormatter.format(report.sessions) : null}
        detail="Sesiones que vieron al menos un producto"
        loadError={loadError}
      />
      <SessionStatCard
        className="admin-analytics-views-per-session"
        label="Visualizaciones por sesión"
        value={report ? formatViewsPerSession(report.viewsPerSession) : null}
        detail="Promedio por sesión"
        loadError={loadError}
      />
    </>
  )
}
