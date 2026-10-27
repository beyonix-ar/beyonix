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

/**
 * Variación de una métrica: igual, actividad nueva (antes 0), porcentaje sobre
 * el anterior o, para tasas, diferencia en puntos porcentuales.
 */
export type MetricChange =
  | { kind: "unchanged" }
  | { kind: "new" }
  | { kind: "change"; percent: number }
  | { kind: "points"; points: number }

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
 * Tasas (0–1): diferencia en puntos porcentuales (8% vs 6% → +2 pp), no la
 * variación relativa (+33%). `null` = sin base en ese período: sin tasa actual
 * no se compara; sin tasa anterior es "nueva actividad". Diferencias menores
 * a 0,05 pp son "sin variación".
 */
export function compareRate(current: number | null, previous: number | null): MetricChange | null {
  if (current === null) return null
  if (previous === null) return current > 0 ? { kind: "new" } : { kind: "unchanged" }
  const points = (current - previous) * 100
  return Math.abs(points) < 0.05 ? { kind: "unchanged" } : { kind: "points", points }
}

/** ¿La métrica subió? (`null` = sin cambio). */
function rose(change: MetricChange): boolean | null {
  switch (change.kind) {
    case "unchanged":
      return null
    case "new":
      return true
    case "change":
      return change.percent > 0
    case "points":
      return change.points > 0
  }
}

/**
 * Tono de la variación según si subir es bueno para esa métrica (vistas,
 * sesiones y conversiones; para el abandono, subir es malo).
 */
export function metricChangeTone(change: MetricChange, higherIsBetter = true): "positive" | "negative" | "neutral" {
  const up = rose(change)
  if (up === null) return "neutral"
  return up === higherIsBetter ? "positive" : "negative"
}

/** Dirección de la flecha (independiente de si es bueno o malo). */
export function metricChangeDirection(change: MetricChange): "up" | "down" | "flat" {
  const up = rose(change)
  return up === null ? "flat" : up ? "up" : "down"
}

const percentFormatter = new Intl.NumberFormat("es-AR", { maximumFractionDigits: 1, signDisplay: "always" })

/** 18 → "+18%"; -7 → "-7%"; 3.456 → "+3,5%"; cambios menores a 0,05 → "+<0,1%". */
export function formatChangePercent(percent: number) {
  if (Math.abs(percent) < 0.05) return `${percent > 0 ? "+" : "-"}<0,1%`
  return `${percentFormatter.format(percent)}%`
}

/** 2 → "+2 pp"; -1.84 → "-1,8 pp". */
export function formatChangePoints(points: number) {
  return `${percentFormatter.format(points)} pp`
}
