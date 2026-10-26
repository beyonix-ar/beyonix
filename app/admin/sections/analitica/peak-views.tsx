"use client"

import {
  formatHourRange,
  formatWeekday,
  type PeakHourReport,
  type PeakWeekdayReport,
} from "@/lib/analytics/peak-views-report"
import { formatSharePercent, type AnalyticsDateRange } from "@/lib/analytics/product-view-report"

import { AdminHelpTip } from "../../components/admin-help-tip"
import { useAnalyticsReport, type AnalyticsReportState } from "./use-analytics-report"

const viewsFormatter = new Intl.NumberFormat("es-AR")

const PEAK_HOUR_HELP =
  "Franja de una hora (hora de Argentina) con más visualizaciones de productos en el período. Cuenta visualizaciones, no visitantes. Si hay empate, se muestra la franja más temprana."
const PEAK_WEEKDAY_HELP =
  "Día de la semana (hora de Argentina) que sumó más visualizaciones de productos en el período. Cuenta visualizaciones, no visitantes. Si hay empate, se muestra el día más temprano de la semana (de lunes a domingo)."

export function usePeakHourReport(range: AnalyticsDateRange | null, rangeKey: string | null) {
  return useAnalyticsReport<PeakHourReport>("/api/admin/analytics/peak-hour", "No se pudo cargar el horario pico de visualizaciones.", range, rangeKey)
}

export function usePeakWeekdayReport(range: AnalyticsDateRange | null, rangeKey: string | null) {
  return useAnalyticsReport<PeakWeekdayReport>("/api/admin/analytics/peak-weekday", "No se pudo cargar el día con más visualizaciones.", range, rangeKey)
}

interface PeakViewsCardProps {
  className: string
  label: string
  help: string
  /** Franja/día ganador ya formateado; `null` si todavía no hay reporte o no hay vistas. */
  value: string | null
  peak: { views: number; sharePercent: number } | null
  hasReport: boolean
  loadError: string | null
}

function PeakViewsCard({ className, label, help, value, peak, hasReport, loadError }: PeakViewsCardProps) {
  const shown = peak && value ? value : hasReport ? "Sin datos" : loadError ? "—" : "…"

  return (
    <div className={`admin-dashboard-kpi ${className} min-w-0 rounded-2xl border px-4 py-3 sm:max-xl:odd:last:col-span-2 xl:col-span-3`} aria-busy={!hasReport && !loadError}>
      <p className="text-10px font-black uppercase leading-tight tracking-widest text-white/52">
        {label}{" "}
        <span className="inline-flex align-middle">
          <AdminHelpTip label={label} text={help} />
        </span>
      </p>
      <p className="mt-1 truncate text-2xl font-black tabular-nums text-white">{shown}</p>
      {peak && value && (
        <>
          <p className="mt-0.5 truncate text-xs font-bold tabular-nums text-white/80">
            {viewsFormatter.format(peak.views)} {peak.views === 1 ? "visualización" : "visualizaciones"}
          </p>
          <p className="truncate text-11px text-white/52">
            {formatSharePercent(peak.sharePercent)} de las visualizaciones del período
          </p>
        </>
      )}
      {!hasReport && loadError && <p className="mt-0.5 truncate text-11px text-white/52">{loadError}</p>}
    </div>
  )
}

export function PeakHourCard({ report, loadError }: AnalyticsReportState<PeakHourReport>) {
  const peak = report?.peak ?? null
  return (
    <PeakViewsCard
      className="admin-analytics-peak-hour"
      label="Horario pico de visualizaciones"
      help={PEAK_HOUR_HELP}
      value={peak ? formatHourRange(peak.hour) : null}
      peak={peak}
      hasReport={report !== null}
      loadError={loadError}
    />
  )
}

export function PeakWeekdayCard({ report, loadError }: AnalyticsReportState<PeakWeekdayReport>) {
  const peak = report?.peak ?? null
  return (
    <PeakViewsCard
      className="admin-analytics-peak-weekday"
      label="Día con más visualizaciones"
      help={PEAK_WEEKDAY_HELP}
      value={peak ? formatWeekday(peak.weekday) : null}
      peak={peak}
      hasReport={report !== null}
      loadError={loadError}
    />
  )
}
