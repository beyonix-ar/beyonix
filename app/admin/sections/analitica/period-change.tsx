"use client"

import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react"

import {
  compareMetric,
  formatChangePercent,
  metricChangeTone,
  type PeriodComparisonReport,
  type PeriodMetrics,
} from "@/lib/analytics/period-comparison"
import { formatAnalyticsRange, type AnalyticsDateRange } from "@/lib/analytics/product-view-report"

import { useAnalyticsReport } from "./use-analytics-report"

export function usePeriodComparisonReport(range: AnalyticsDateRange | null, rangeKey: string | null) {
  return useAnalyticsReport<PeriodComparisonReport>(
    "/api/admin/analytics/comparison",
    "No se pudo cargar la comparación con el período anterior.",
    range,
    rangeKey,
  )
}

export type ComparedMetric = keyof PeriodMetrics

interface PeriodChangeProps {
  comparison: PeriodComparisonReport | null
  metric: ComparedMetric
  /** Si subir es bueno para esta métrica (verde al subir). */
  higherIsBetter?: boolean
}

/**
 * Línea discreta de variación contra el período inmediatamente anterior:
 * flecha, signo y texto además del color. Sin comparación del período
 * mostrado (cargando, error o datos incoherentes) no se muestra nada.
 */
export function PeriodChange({ comparison, metric, higherIsBetter = true }: PeriodChangeProps) {
  if (!comparison?.current || !comparison.previous) return null
  const change = compareMetric(comparison.current[metric], comparison.previous[metric])
  const tone = metricChangeTone(change, higherIsBetter)
  const Icon = change.kind === "unchanged" ? Minus : change.kind === "new" || change.percent > 0 ? ArrowUpRight : ArrowDownRight

  return (
    <p
      className="admin-analytics-change mt-0.5 truncate text-11px"
      data-tone={tone}
      title={`Comparado con el período inmediatamente anterior de la misma duración (${formatAnalyticsRange(comparison.previousRange)}).`}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      {change.kind === "change" ? (
        <>
          <span className="font-black tabular-nums">{formatChangePercent(change.percent)}</span>{" "}
          <span className="admin-analytics-change-context">vs período anterior</span>
        </>
      ) : (
        <span className="font-black">{change.kind === "new" ? "Nueva actividad" : "Sin variación"}</span>
      )}
    </p>
  )
}
