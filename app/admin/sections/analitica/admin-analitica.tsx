"use client"

import { useEffect, useMemo, useState } from "react"
import { Eye } from "lucide-react"

import { argentinaDateKey } from "@/lib/business/dashboard-timezone"
import {
  ANALYTICS_MAX_RANGE_DAYS,
  ANALYTICS_PERIOD_PRESETS,
  formatAnalyticsRange,
  formatSharePercent,
  resolveAnalyticsPeriod,
  type AnalyticsPeriodPreset,
  type ProductViewReport,
} from "@/lib/analytics/product-view-report"

import { AdminDatePicker } from "../../components/admin-date-picker"
import { AdminHelpTip } from "../../components/admin-help-tip"
import { AdminEmptyState, AdminPageHeader, AdminSkeleton } from "../../components/admin-controls"
import { ProductThumbnail } from "../productos/product-thumbnail"
import { AnalyticsRefreshControl, AnalyticsRefreshProvider, useAnalyticsRefresh } from "./analytics-refresh"
import { PeakHourCard, PeakWeekdayCard, usePeakHourReport, usePeakWeekdayReport } from "./peak-views"
import { ProductViewsChart } from "./product-views-chart"
import { useAnalyticsReport } from "./use-analytics-report"
import { useWeekdayViewsReport, WeekdayViewsSection } from "./weekday-views-chart"

const viewsFormatter = new Intl.NumberFormat("es-AR")

const UNIQUE_VIEW_HELP =
  "Una vista es una apertura real del producto (página o vista rápida). Recargar o volver al mismo producto dentro de 30 minutos en la misma sesión no suma otra vista. No se cuentan la navegación del equipo ni los robots."

const LOAD_ERROR = "No se pudieron cargar las vistas de productos."

function MetricCard({ label, help, value, detail }: { label: string; help?: string; value: string; detail?: string }) {
  return (
    <div className="admin-dashboard-kpi min-w-0 rounded-2xl border px-4 py-3 xl:col-span-2">
      <p className="flex items-center gap-1 text-10px font-black uppercase tracking-widest text-white/52">
        {label}
        {help && <AdminHelpTip label={label} text={help} />}
      </p>
      <p className="mt-1 truncate text-2xl font-black tabular-nums text-white" title={value}>{value}</p>
      {detail && <p className="mt-0.5 truncate text-11px text-white/52">{detail}</p>}
    </div>
  )
}

function viewsLabel(views: number) {
  return `${viewsFormatter.format(views)} ${views === 1 ? "vista" : "vistas"}`
}

/** Admin > Analítica: todos los módulos comparten el mismo ciclo de auto-actualización. */
export function AdminAnalitica() {
  return (
    <AnalyticsRefreshProvider>
      <AnalyticsPage />
    </AnalyticsRefreshProvider>
  )
}

function AnalyticsPage() {
  const [preset, setPreset] = useState<AnalyticsPeriodPreset>("7d")
  const [customFrom, setCustomFrom] = useState("")
  const [customTo, setCustomTo] = useState("")
  const [todayKey] = useState(() => argentinaDateKey(new Date()))
  const { restart } = useAnalyticsRefresh()

  const range = useMemo(
    () => resolveAnalyticsPeriod(preset, todayKey, { from: customFrom, to: customTo }),
    [preset, todayKey, customFrom, customTo],
  )
  const rangeKey = range ? `${range.from}:${range.to}` : null

  // Productos más vistos, horario pico, día con más visualizaciones y
  // visualizaciones por día: tareas del mismo ciclo global, siempre con el
  // período que muestran los filtros.
  const { report, loadError } = useAnalyticsReport<ProductViewReport>("/api/admin/analytics/product-views", LOAD_ERROR, range, rangeKey)
  const peakHour = usePeakHourReport(range, rangeKey)
  const peakWeekday = usePeakWeekdayReport(range, rangeKey)
  const weekdayViews = useWeekdayViewsReport(range, rangeKey)

  // Nuevo período: carga ya y el contador vuelve a 01:00 al terminar.
  useEffect(() => {
    if (rangeKey) void restart()
  }, [rangeKey, restart])

  const customIncomplete = preset === "custom" && !customFrom

  return (
    <div className="admin-analytics-page min-w-0 space-y-4 p-3 sm:p-4 lg:p-5">
      <AdminPageHeader
        eyebrow="Analítica"
        title="Productos más vistos"
        description="Qué productos reciben más visitas en la tienda."
        className="md:flex-row md:items-start md:justify-between xl:items-start"
        actions={<AnalyticsRefreshControl />}
      />

      <section className="admin-dashboard-filters rounded-2xl border p-4" aria-label="Período">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div role="group" aria-label="Período" className="admin-dash-segmented admin-analytics-periods">
            {ANALYTICS_PERIOD_PRESETS.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={preset === option.value}
                onClick={() => setPreset(option.value)}
                className="admin-dash-segmented-option"
              >
                {option.label}
              </button>
            ))}
          </div>
          <p className="text-xs font-semibold text-white/60" aria-live="polite">
            {range ? formatAnalyticsRange(range) : ""}
          </p>
        </div>

        {preset === "custom" && (
          <div className="mt-3 grid gap-2.5 sm:grid-cols-2 lg:max-w-xl">
            <AdminDatePicker title="Desde" ariaLabel="Fecha inicial" value={customFrom} placeholder="Desde" onChange={setCustomFrom} />
            <AdminDatePicker title="Hasta" ariaLabel="Fecha final" value={customTo} placeholder="Hoy" onChange={setCustomTo} />
          </div>
        )}
        {preset === "custom" && !range && (
          <p role={customIncomplete ? undefined : "alert"} className={`mt-2 text-xs font-semibold ${customIncomplete ? "text-white/55" : "text-red-300"}`}>
            {customIncomplete
              ? "Elegí la fecha inicial del período."
              : `Revisá las fechas: “Desde” no puede ser posterior a “Hasta” y el período no puede superar ${ANALYTICS_MAX_RANGE_DAYS} días.`}
          </p>
        )}
      </section>

      {range && (
        // Desktop: 3 métricas de resumen arriba y las 2 de pico abajo (grilla de 6).
        <div className="admin-analytics-metrics grid gap-2.5 sm:grid-cols-2 xl:grid-cols-6">
          {report && report.totalViews > 0 && report.topProduct && (
            <>
              <MetricCard label="Vistas totales" help={UNIQUE_VIEW_HELP} value={viewsFormatter.format(report.totalViews)} />
              <MetricCard label="Productos vistos" value={viewsFormatter.format(report.productsViewed)} />
              <MetricCard
                label="Producto más visto"
                value={report.topProduct.name}
                detail={`${viewsLabel(report.topProduct.views)} · ${formatSharePercent(report.topProduct.sharePercent)} del total`}
              />
            </>
          )}
          <PeakHourCard {...peakHour} />
          <PeakWeekdayCard {...peakWeekday} />
        </div>
      )}

      {range && <WeekdayViewsSection {...weekdayViews} />}

      {range && !report && !loadError && (
        <div aria-busy="true" aria-label="Cargando vistas" className="space-y-4">
          <AdminSkeleton rows={4} />
        </div>
      )}

      {loadError && (
        <div role="alert" className="rounded-2xl border border-red-400/20 bg-red-400/10 px-4 py-3 text-sm text-red-200">
          {loadError}
        </div>
      )}

      {report && report.totalViews === 0 && (
        <AdminEmptyState
          icon={<Eye className="size-5" />}
          title="Sin datos de visualización para este período."
          description="Probá con otro rango de fechas."
        />
      )}

      {report && report.totalViews > 0 && report.topProduct && (
        <>
          <div className="grid min-w-0 items-start gap-4 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
            <section className="admin-dashboard-filters min-w-0 rounded-2xl border p-4" aria-labelledby="analytics-top-title">
              <h2 id="analytics-top-title" className="mb-3 text-sm font-black text-white">
                Top 10 por vistas
              </h2>
              <ProductViewsChart entries={report.ranking} />
            </section>

            <section className="admin-dashboard-filters min-w-0 rounded-2xl border p-4" aria-labelledby="analytics-ranking-title">
              <h2 id="analytics-ranking-title" className="mb-3 text-sm font-black text-white">
                Ranking de productos
              </h2>
              <div role="table" aria-labelledby="analytics-ranking-title" className="admin-analytics-ranking">
                <div role="row" className="admin-analytics-ranking-row admin-analytics-ranking-head">
                  <span role="columnheader">#</span>
                  <span role="columnheader">Producto</span>
                  <span role="columnheader" className="text-right">Vistas</span>
                  <span role="columnheader" className="text-right">% del total</span>
                </div>
                {report.ranking.map((entry) => (
                  <div role="row" key={entry.productId} className="admin-analytics-ranking-row">
                    <span role="cell" className="font-black tabular-nums text-white/60">{entry.position}</span>
                    <span role="cell" className="flex min-w-0 items-center gap-2.5">
                      <ProductThumbnail image={entry.image} alt={`Imagen de ${entry.name}`} size="sm" />
                      {entry.available && entry.slug ? (
                        <a
                          href={`/productos/${encodeURIComponent(entry.slug)}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="min-w-0 truncate text-sm font-bold text-white hover:underline"
                          title={entry.name}
                        >
                          {entry.name}
                        </a>
                      ) : (
                        <span className="min-w-0" title={entry.name}>
                          <span className="block truncate text-sm font-bold text-white">{entry.name}</span>
                          <span className="block text-11px text-white/45">No publicado</span>
                        </span>
                      )}
                    </span>
                    <span role="cell" className="text-right text-sm font-black tabular-nums text-white">
                      {viewsFormatter.format(entry.views)}
                    </span>
                    <span role="cell" className="text-right text-sm font-semibold tabular-nums text-white/70">
                      {formatSharePercent(entry.sharePercent)}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </>
      )}
    </div>
  )
}
