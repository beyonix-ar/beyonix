"use client"

import { useCallback, useState } from "react"

import { formatHourRange, type PeakHourReport } from "@/lib/analytics/peak-hour-report"
import { formatSharePercent, type AnalyticsDateRange } from "@/lib/analytics/product-view-report"

import { AdminHelpTip } from "../../components/admin-help-tip"
import { fetchAnalyticsReport } from "./analytics-api"
import { useAnalyticsRefreshTask } from "./analytics-refresh"

const LOAD_ERROR = "No se pudo cargar el horario pico de visualizaciones."
const viewsFormatter = new Intl.NumberFormat("es-AR")

const PEAK_HOUR_HELP =
  "Franja de una hora (hora de Argentina) con más visualizaciones de productos en el período. Cuenta visualizaciones, no visitantes. Si hay empate, se muestra la franja más temprana."

export interface PeakHourState {
  report: PeakHourReport | null
  loadError: string | null
}

/**
 * Datos del horario pico dentro del ciclo global de Analítica. Va montado
 * siempre en la página (no en la card) para que su tarea siga registrada
 * aunque otra sección esté cargando. Un refresh fallido conserva el último
 * dato válido del mismo período.
 */
export function usePeakHourReport(range: AnalyticsDateRange | null, rangeKey: string | null): PeakHourState {
  const [loaded, setLoaded] = useState<{ key: string; report: PeakHourReport } | null>(null)
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null)

  const load = useCallback(async (signal: AbortSignal) => {
    if (!range || !rangeKey) return
    try {
      const report = await fetchAnalyticsReport<PeakHourReport>("/api/admin/analytics/peak-hour", range, signal, LOAD_ERROR)
      if (signal.aborted) return
      setLoaded({ key: rangeKey, report })
      setFailure(null)
    } catch (error) {
      if (signal.aborted) return
      setFailure({ key: rangeKey, message: error instanceof Error ? error.message : LOAD_ERROR })
      throw error
    }
  }, [range, rangeKey])
  useAnalyticsRefreshTask(load)

  const report = loaded?.key === rangeKey ? loaded.report : null
  return { report, loadError: !report && failure?.key === rangeKey ? failure.message : null }
}

export function PeakHourCard({ report, loadError }: PeakHourState) {
  const peak = report?.peak ?? null
  const value = peak ? formatHourRange(peak.hour) : report ? "Sin datos" : loadError ? "—" : "…"

  return (
    <div className="admin-dashboard-kpi admin-analytics-peak-hour min-w-0 rounded-2xl border px-4 py-3" aria-busy={!report && !loadError}>
      <p className="text-10px font-black uppercase leading-tight tracking-widest text-white/52">
        Horario pico de visualizaciones{" "}
        <span className="inline-flex align-middle">
          <AdminHelpTip label="Horario pico de visualizaciones" text={PEAK_HOUR_HELP} />
        </span>
      </p>
      <p className="mt-1 truncate text-2xl font-black tabular-nums text-white">{value}</p>
      {peak && (
        <>
          <p className="mt-0.5 truncate text-xs font-bold tabular-nums text-white/80">
            {viewsFormatter.format(peak.views)} {peak.views === 1 ? "visualización" : "visualizaciones"}
          </p>
          <p className="truncate text-11px text-white/52">
            {formatSharePercent(peak.sharePercent)} de las visualizaciones del período
          </p>
        </>
      )}
      {!report && loadError && <p className="mt-0.5 truncate text-11px text-white/52">{loadError}</p>}
    </div>
  )
}
