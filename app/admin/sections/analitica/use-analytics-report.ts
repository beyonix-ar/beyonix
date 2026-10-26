"use client"

import { useCallback, useState } from "react"

import type { AnalyticsDateRange } from "@/lib/analytics/product-view-report"

import { fetchAnalyticsReport } from "./analytics-api"
import { useAnalyticsRefreshTask } from "./analytics-refresh"

export interface AnalyticsReportState<T> {
  report: T | null
  loadError: string | null
}

/**
 * Reporte de un módulo dentro del ciclo global de Analítica: cada refresh
 * consulta exactamente el período elegido. Va montado siempre en la página
 * para que su tarea siga registrada aunque otra sección esté cargando. Un
 * refresh fallido conserva el último dato válido del mismo período; otro
 * período nunca muestra datos del anterior.
 */
export function useAnalyticsReport<T>(
  path: string,
  loadErrorMessage: string,
  range: AnalyticsDateRange | null,
  rangeKey: string | null,
): AnalyticsReportState<T> {
  const [loaded, setLoaded] = useState<{ key: string; report: T } | null>(null)
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null)

  const load = useCallback(async (signal: AbortSignal) => {
    if (!range || !rangeKey) return
    try {
      const report = await fetchAnalyticsReport<T>(path, range, signal, loadErrorMessage)
      if (signal.aborted) return
      setLoaded({ key: rangeKey, report })
      setFailure(null)
    } catch (error) {
      if (signal.aborted) return
      setFailure({ key: rangeKey, message: error instanceof Error ? error.message : loadErrorMessage })
      throw error
    }
  }, [path, loadErrorMessage, range, rangeKey])
  useAnalyticsRefreshTask(load)

  const report = loaded?.key === rangeKey ? loaded.report : null
  return { report, loadError: !report && failure?.key === rangeKey ? failure.message : null }
}
