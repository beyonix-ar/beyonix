"use client"

import { formatHourRange, viewsAxisScale, type HourlyViewsReport } from "@/lib/analytics/peak-views-report"
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
 * Histograma compacto: X = las 24 horas (00 a 23, siempre todas), Y =
 * visualizaciones con escala "redonda" según el máximo del período y líneas
 * guía. Las horas en 0 quedan como una marca mínima. Sin valores sobre las
 * barras para no saturar: hover/foco/toque sobre cualquier columna muestra la
 * franja exacta, visualizaciones y participación. En anchos chicos el eje X
 * rotula cada 3 horas, pero las 24 columnas siguen siendo interactivas.
 */
function HourlyViewsChart({ report }: { report: HourlyViewsReport }) {
  const { top, ticks } = viewsAxisScale(Math.max(...report.hours.map((slot) => slot.views)))
  const position = (views: number) => `${(views / top) * 100}%`

  return (
    <div className="admin-analytics-hours-chart">
      <div className="admin-analytics-hours-y text-10px font-bold tabular-nums text-white/55" aria-hidden="true">
        {ticks.map((tick) => (
          <span key={tick}>{viewsFormatter.format(tick)}</span>
        ))}
      </div>
      <div className="admin-analytics-hours-plot">
        <div className="admin-analytics-hours-grid" aria-hidden="true">
          {ticks.map((tick) => <span key={tick} style={{ bottom: position(tick) }} />)}
        </div>
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
                    data-empty={slot.views === 0 || undefined}
                    style={slot.views > 0 ? { height: position(slot.views) } : undefined}
                  />
                </span>
                <span
                  className={`admin-analytics-hour-label text-10px font-bold tabular-nums text-white/70${slot.hour % 3 === 0 ? "" : " admin-analytics-hour-label-minor"}`}
                  aria-hidden="true"
                >
                  {String(slot.hour).padStart(2, "0")}
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
      </div>
    </div>
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
