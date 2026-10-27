"use client"

import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react"

import {
  compareMetric,
  formatChangePercent,
  formatChangePoints,
  metricChangeDirection,
  metricChangeTone,
  type MetricChange,
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

const ICONS = { up: ArrowUpRight, down: ArrowDownRight, flat: Minus } as const

interface ChangeLineProps {
  /** `null`: sin comparación disponible (no se muestra nada). */
  change: MetricChange | null
  previousRange: AnalyticsDateRange
  /** Si subir es bueno para esta métrica (verde al subir; rojo si no). */
  higherIsBetter?: boolean
}

/**
 * Línea discreta de variación contra el período inmediatamente anterior:
 * flecha, signo y texto además del color. Sirve para cantidades (%) y tasas
 * (puntos porcentuales).
 */
export function ChangeLine({ change, previousRange, higherIsBetter = true }: ChangeLineProps) {
  if (!change) return null
  const Icon = ICONS[metricChangeDirection(change)]
  const amount = change.kind === "change" ? formatChangePercent(change.percent) : change.kind === "points" ? formatChangePoints(change.points) : null

  return (
    <p
      className="admin-analytics-change mt-0.5 truncate text-11px"
      data-tone={metricChangeTone(change, higherIsBetter)}
      title={`Comparado con el período inmediatamente anterior de la misma duración (${formatAnalyticsRange(previousRange)}).`}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      {amount ? (
        <>
          <span className="font-black tabular-nums">{amount}</span>{" "}
          <span className="admin-analytics-change-context">vs período anterior</span>
        </>
      ) : (
        <span className="font-black">{change.kind === "new" ? "Nueva actividad" : "Sin variación"}</span>
      )}
    </p>
  )
}

interface PeriodChangeProps {
  comparison: PeriodComparisonReport | null
  metric: ComparedMetric
  higherIsBetter?: boolean
}

/**
 * Variación de una métrica del resumen. Sin comparación del período mostrado
 * (cargando, error o datos incoherentes) no se muestra nada.
 */
export function PeriodChange({ comparison, metric, higherIsBetter = true }: PeriodChangeProps) {
  if (!comparison?.current || !comparison.previous) return null
  return (
    <ChangeLine
      change={compareMetric(comparison.current[metric], comparison.previous[metric])}
      previousRange={comparison.previousRange}
      higherIsBetter={higherIsBetter}
    />
  )
}
