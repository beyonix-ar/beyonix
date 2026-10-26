"use client"

import {
  formatWeekday,
  formatWeekdayShort,
  type WeekdayViewsReport,
} from "@/lib/analytics/peak-views-report"
import { formatSharePercent, type AnalyticsDateRange } from "@/lib/analytics/product-view-report"

import { AdminSkeleton } from "../../components/admin-controls"
import { useAnalyticsReport, type AnalyticsReportState } from "./use-analytics-report"

const viewsFormatter = new Intl.NumberFormat("es-AR")

const viewsLabel = (views: number) => `${viewsFormatter.format(views)} ${views === 1 ? "visualización" : "visualizaciones"}`

export function useWeekdayViewsReport(range: AnalyticsDateRange | null, rangeKey: string | null) {
  return useAnalyticsReport<WeekdayViewsReport>(
    "/api/admin/analytics/views-by-weekday",
    "No se pudieron cargar las visualizaciones por día de la semana.",
    range,
    rangeKey,
  )
}

/**
 * Columnas de lunes a domingo (siempre las 7, con 0 si no hubo vistas): una
 * sola serie, así que un solo tono y sin leyenda, como el Top 10. El valor va
 * sobre cada barra; hover/foco/toque muestra día, visualizaciones y
 * participación del total.
 */
function WeekdayViewsChart({ report }: { report: WeekdayViewsReport }) {
  const max = Math.max(...report.days.map((day) => day.views))

  return (
    <ol className="admin-analytics-weekdays" aria-label="Visualizaciones por día de la semana">
      {report.days.map((day) => {
        const name = formatWeekday(day.weekday)
        const share = formatSharePercent(day.sharePercent)
        return (
          <li
            key={day.weekday}
            className="admin-analytics-weekday"
            tabIndex={0}
            aria-label={`${name}: ${viewsLabel(day.views)}, ${share} del total`}
          >
            <span className="admin-analytics-weekday-track" aria-hidden="true">
              <span
                className="admin-analytics-weekday-bar"
                style={{ height: `${max > 0 && day.views > 0 ? Math.max((day.views / max) * 100, 2) : 0}%` }}
              >
                <span className="admin-analytics-weekday-value text-xs font-black tabular-nums text-white">
                  {viewsFormatter.format(day.views)}
                </span>
              </span>
            </span>
            <span className="text-11px font-bold text-white/70" aria-hidden="true">
              {formatWeekdayShort(day.weekday)}
            </span>
            <span className="admin-analytics-weekday-tooltip" role="presentation">
              <span className="block font-black">{name}</span>
              <span className="block font-bold">{viewsLabel(day.views)}</span>
              <span className="block font-semibold opacity-75">{share} del total</span>
            </span>
          </li>
        )
      })}
    </ol>
  )
}

/**
 * Sección "Visualizaciones por día de la semana". Mientras carga un período
 * nuevo no muestra datos del anterior; un refresh fallido conserva el último
 * dato válido (el aviso es el global del cronómetro).
 */
export function WeekdayViewsSection({ report, loadError }: AnalyticsReportState<WeekdayViewsReport>) {
  return (
    <section
      className="admin-dashboard-filters admin-analytics-weekday-section min-w-0 rounded-2xl border p-4"
      aria-labelledby="analytics-weekday-title"
      aria-busy={!report && !loadError}
    >
      <h2 id="analytics-weekday-title" className="mb-3 text-sm font-black text-white">
        Visualizaciones por día de la semana
      </h2>
      {report ? (
        <>
          <WeekdayViewsChart report={report} />
          {report.totalViews === 0 && (
            <p className="mt-2 text-center text-xs font-semibold text-white/55">Sin visualizaciones en este período</p>
          )}
        </>
      ) : loadError ? (
        <p className="text-xs font-semibold text-white/55">{loadError}</p>
      ) : (
        <AdminSkeleton rows={2} />
      )}
    </section>
  )
}
