import { addDays, daysBetweenInclusive, getVariationPercent } from "../business/dashboard-sales-analytics.ts"
import type { AnalyticsDateRange } from "./product-view-report.ts"
import { buildSessionStatsReport } from "./session-stats-report.ts"

/**
 * Admin > Analítica: comparación de las métricas principales contra el período
 * inmediatamente anterior. Los números base (vistas, productos vistos y
 * sesiones de cada período) los cuenta `admin_product_view_period_comparison`
 * en una sola agregación; acá se valida, se calcula el promedio por sesión y la
 * variación.
 */

/**
 * Período anterior de la misma cantidad de días calendario de Argentina, que
 * termina el día previo a `range.from`: sin huecos ni solapamiento. Hoy → ayer;
 * 21–27 oct → 14–20 oct; 10–15 oct → 4–9 oct.
 */
export function previousAnalyticsRange(range: AnalyticsDateRange): AnalyticsDateRange {
  const days = daysBetweenInclusive(range)
  return { from: addDays(range.from, -days), to: addDays(range.from, -1) }
}

export interface PeriodMetrics {
  totalViews: number
  productsViewed: number
  sessions: number
  /** Vistas / sesiones del MISMO período; `null` sin sesiones. */
  viewsPerSession: number | null
}

export interface PeriodComparisonReport {
  range: AnalyticsDateRange
  previousRange: AnalyticsDateRange
  /** `null` si la base devolvió datos incoherentes para ese período (no se compara). */
  current: PeriodMetrics | null
  previous: PeriodMetrics | null
}

export interface PeriodCounts {
  totalViews: number
  productsViewed: number
  sessions: number
}

function periodMetrics(range: AnalyticsDateRange, counts: PeriodCounts | undefined): PeriodMetrics | null {
  if (!counts) return null
  const { totalViews, productsViewed, sessions } = counts
  const valid =
    [totalViews, productsViewed, sessions].every((value) => Number.isInteger(value) && value >= 0) &&
    // Cada producto y cada sesión contados tienen al menos una vista; sin vistas, ninguno.
    productsViewed <= totalViews &&
    sessions <= totalViews &&
    (totalViews === 0) === (productsViewed === 0) &&
    (totalViews === 0) === (sessions === 0)
  if (!valid) return null
  return { totalViews, productsViewed, sessions, viewsPerSession: buildSessionStatsReport(range, { totalViews, sessions }).viewsPerSession }
}

export function buildPeriodComparisonReport(
  range: AnalyticsDateRange,
  counts: { current: PeriodCounts; previous: PeriodCounts } | null,
): PeriodComparisonReport {
  const previousRange = previousAnalyticsRange(range)
  return {
    range,
    previousRange,
    current: periodMetrics(range, counts?.current),
    previous: periodMetrics(previousRange, counts?.previous),
  }
}

/** Variación de una métrica: igual, actividad nueva (antes 0) o porcentaje sobre el anterior. */
export type MetricChange = { kind: "unchanged" } | { kind: "new" } | { kind: "change"; percent: number }

/**
 * `((actual - anterior) / anterior) * 100`. Un valor `null` (promedio sin
 * sesiones) vale 0: 0 → 0 es "sin variación" y 0 → algo es "nueva actividad",
 * nunca ±Infinity.
 */
export function compareMetric(current: number | null, previous: number | null): MetricChange {
  const now = current ?? 0
  const before = previous ?? 0
  if (now === before) return { kind: "unchanged" }
  const percent = getVariationPercent(now, before)
  return percent === null ? { kind: "new" } : { kind: "change", percent }
}

/**
 * Tono de la variación según si subir es bueno para esa métrica (para todas
 * las de hoy lo es; queda parametrizado para métricas donde subir es malo).
 */
export function metricChangeTone(change: MetricChange, higherIsBetter = true): "positive" | "negative" | "neutral" {
  if (change.kind === "unchanged") return "neutral"
  const up = change.kind === "new" || change.percent > 0
  return up === higherIsBetter ? "positive" : "negative"
}

const percentFormatter = new Intl.NumberFormat("es-AR", { maximumFractionDigits: 1, signDisplay: "always" })

/** 18 → "+18%"; -7 → "-7%"; 3.456 → "+3,5%"; cambios menores a 0,05 → "+<0,1%". */
export function formatChangePercent(percent: number) {
  if (Math.abs(percent) < 0.05) return `${percent > 0 ? "+" : "-"}<0,1%`
  return `${percentFormatter.format(percent)}%`
}
