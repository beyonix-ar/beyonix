"use client"

import { formatHourRange, type HourlyViewsReport } from "@/lib/analytics/peak-views-report"
import { formatSharePercent, type AnalyticsDateRange } from "@/lib/analytics/product-view-report"

import { AdminSkeleton } from "../../components/admin-controls"
import { useAnalyticsReport, type AnalyticsReportState } from "./use-analytics-report"

const viewsFormatter = new Intl.NumberFormat("es-AR")

const viewsLabel = (views: number) => `${viewsFormatter.format(views)} ${views === 1 ? "visualización" : "visualizaciones"}`

export function useHourlyViewsReport(range: AnalyticsDateRange | null, rangeKey: string | null) {
  return useAnalyticsReport<HourlyViewsReport>(
    "/api/admin/analytics/views-by-hour",
    "No se pudieron cargar las visualizaciones por hora del día.",
    range,
    rangeKey,
  )
}

/**
 * 24 columnas compactas (00 a 23, siempre todas, con 0 si no hubo vistas),
 * mismo azul que el resto de Analítica. Sin valores sobre las barras para no
 * saturar: el eje marca cada 3 horas y hover/foco/toque sobre cualquier
 * columna muestra la franja exacta, visualizaciones y participación.
 */
function HourlyViewsChart({ report }: { report: HourlyViewsReport }) {
  const max = Math.max(...report.hours.map((slot) => slot.views))

  return (
    <ol className="admin-analytics-hours" aria-label="Visualizaciones por hora del día">
      {report.hours.map((slot) => {
        const range = formatHourRange(slot.hour)
        const share = formatSharePercent(slot.sharePercent)
        return (
          <li
            key={slot.hour}
            className="admin-analytics-hour"
            tabIndex={0}
            aria-label={`${range}: ${viewsLabel(slot.views)}, ${share} del total`}
          >
            <span className="admin-analytics-hour-track" aria-hidden="true">
              <span
                className="admin-analytics-hour-bar"
                style={{ height: `${max > 0 && slot.views > 0 ? Math.max((slot.views / max) * 100, 2) : 0}%` }}
              />
            </span>
            <span className="admin-analytics-hour-label text-10px font-bold tabular-nums text-white/70" aria-hidden="true">
              {slot.hour % 3 === 0 ? String(slot.hour).padStart(2, "0") : ""}
            </span>
            <span className="admin-analytics-hour-tooltip" role="presentation">
              <span className="block font-black">{range}</span>
              <span className="block font-bold">{viewsLabel(slot.views)}</span>
              <span className="block font-semibold opacity-75">{share} del total</span>
            </span>
          </li>
        )
      })}
    </ol>
  )
}

/**
 * Sección "Visualizaciones por hora del día". Mientras carga un período
 * nuevo no muestra datos del anterior; un refresh fallido conserva el último
 * dato válido (el aviso es el global del cronómetro).
 */
export function HourlyViewsSection({ report, loadError }: AnalyticsReportState<HourlyViewsReport>) {
  return (
    <section
      className="admin-dashboard-filters admin-analytics-hour-section min-w-0 rounded-2xl border p-4"
      aria-labelledby="analytics-hour-title"
      aria-busy={!report && !loadError}
    >
      <h2 id="analytics-hour-title" className="mb-3 text-sm font-black text-white">
        Visualizaciones por hora del día
      </h2>
      {report ? (
        <>
          <HourlyViewsChart report={report} />
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
