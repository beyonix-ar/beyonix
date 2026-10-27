import assert from "node:assert/strict"
import test from "node:test"

import { addDays, daysBetweenInclusive } from "../business/dashboard-sales-analytics.ts"
import {
  buildPeriodComparisonReport,
  compareMetric,
  formatChangePercent,
  metricChangeTone,
  previousAnalyticsRange,
} from "./period-comparison.ts"
import { resolveAnalyticsPeriod } from "./product-view-report.ts"

const TODAY = "2026-10-27"

test("período anterior: misma duración, termina el día previo (Hoy, 7 días, 30 días)", () => {
  const previous = (preset: "today" | "7d" | "30d") => previousAnalyticsRange(resolveAnalyticsPeriod(preset, TODAY, { from: "", to: "" })!)
  assert.deepEqual(previous("today"), { from: "2026-10-26", to: "2026-10-26" }, "G: Hoy → ayer (día calendario completo, como Hoy)")
  assert.deepEqual(previous("7d"), { from: "2026-10-14", to: "2026-10-20" }, "H: 21–27 oct → 14–20 oct")
  assert.deepEqual(previous("30d"), { from: "2026-08-29", to: "2026-09-27" }, "I: 28 sep–27 oct → 29 ago–27 sep")
})

test("período anterior personalizado: 1 día, varios días, cambio de mes y de año, bisiesto", () => {
  assert.deepEqual(previousAnalyticsRange({ from: "2026-10-01", to: "2026-10-01" }), { from: "2026-09-30", to: "2026-09-30" }, "J: del 1 al 1 → el día anterior")
  assert.deepEqual(previousAnalyticsRange({ from: "2026-10-10", to: "2026-10-15" }), { from: "2026-10-04", to: "2026-10-09" }, "K: 6 días → 4–9 oct")
  assert.deepEqual(previousAnalyticsRange({ from: "2026-10-01", to: "2026-10-10" }), { from: "2026-09-21", to: "2026-09-30" })
  assert.deepEqual(previousAnalyticsRange({ from: "2026-01-01", to: "2026-01-03" }), { from: "2025-12-29", to: "2025-12-31" })
  assert.deepEqual(previousAnalyticsRange({ from: "2024-03-01", to: "2024-03-01" }), { from: "2024-02-29", to: "2024-02-29" })
})

test("L: sin huecos ni solapamiento y con la misma cantidad de días, para cualquier rango hasta un año", () => {
  for (let start = 0; start < 400; start += 13) {
    for (const days of [1, 2, 6, 7, 30, 31, 366]) {
      const from = addDays("2025-01-01", start)
      const range = { from, to: addDays(from, days - 1) }
      const previous = previousAnalyticsRange(range)
      assert.equal(addDays(previous.to, 1), range.from, `${range.from}+${days}: termina justo el día anterior`)
      assert.equal(daysBetweenInclusive(previous), daysBetweenInclusive(range), `${range.from}+${days}: misma duración`)
    }
  }
})

test("variación: sube, baja, igual, 0 → 0 y 0 → algo", () => {
  assert.deepEqual(compareMetric(120, 100), { kind: "change", percent: 20 }, "A")
  assert.deepEqual(compareMetric(80, 100), { kind: "change", percent: -20 }, "B")
  assert.deepEqual(compareMetric(100, 100), { kind: "unchanged" }, "C")
  assert.deepEqual(compareMetric(0, 0), { kind: "unchanged" }, "D: sin variación, nunca 0/0")
  assert.deepEqual(compareMetric(5, 0), { kind: "new" }, "E: nueva actividad, nunca +Infinity%")
  assert.deepEqual(compareMetric(0, 7), { kind: "change", percent: -100 })
  assert.deepEqual(compareMetric(null, null), { kind: "unchanged" }, "promedio sin sesiones en ambos períodos")
  assert.deepEqual(compareMetric(3, null), { kind: "new" })
})

test("F: redondeo a lo sumo un decimal, con signo y coma (es-AR)", () => {
  assert.equal(formatChangePercent(18), "+18%")
  assert.equal(formatChangePercent(-7), "-7%")
  assert.equal(formatChangePercent(3.5), "+3,5%")
  assert.equal(formatChangePercent(18.333333), "+18,3%")
  assert.equal(formatChangePercent(66.66666), "+66,7%")
  assert.equal(formatChangePercent(-100), "-100%")
  assert.equal(formatChangePercent(1234.5), "+1.234,5%")
  assert.equal(formatChangePercent(0.01), "+<0,1%", "nunca \"+0%\" para un cambio real")
  assert.equal(formatChangePercent(-0.04), "-<0,1%")
})

test("tono: subir es verde salvo que la métrica indique lo contrario", () => {
  assert.equal(metricChangeTone({ kind: "change", percent: 5 }), "positive")
  assert.equal(metricChangeTone({ kind: "change", percent: -5 }), "negative")
  assert.equal(metricChangeTone({ kind: "unchanged" }), "neutral")
  assert.equal(metricChangeTone({ kind: "new" }), "positive")
  assert.equal(metricChangeTone({ kind: "change", percent: 5 }, false), "negative")
  assert.equal(metricChangeTone({ kind: "change", percent: -5 }, false), "positive")
  assert.equal(metricChangeTone({ kind: "unchanged" }, false), "neutral")
})

test("Visualizaciones por sesión: promedio de cada período por separado, después la variación", () => {
  const report = buildPeriodComparisonReport({ from: "2026-10-21", to: "2026-10-27" }, {
    current: { totalViews: 100, productsViewed: 10, sessions: 20 },
    previous: { totalViews: 60, productsViewed: 10, sessions: 20 },
  })
  assert.deepEqual(report.previousRange, { from: "2026-10-14", to: "2026-10-20" })
  assert.deepEqual([report.current?.viewsPerSession, report.previous?.viewsPerSession], [5, 3])
  const change = compareMetric(report.current!.viewsPerSession, report.previous!.viewsPerSession)
  assert.equal(change.kind === "change" && formatChangePercent(change.percent), "+66,7%", "5 vs 3, no (vistas +66,7%) / (sesiones 0%)")
  assert.deepEqual(compareMetric(report.current!.productsViewed, report.previous!.productsViewed), { kind: "unchanged" })

  const empty = buildPeriodComparisonReport({ from: "2026-10-27", to: "2026-10-27" }, {
    current: { totalViews: 0, productsViewed: 0, sessions: 0 },
    previous: { totalViews: 0, productsViewed: 0, sessions: 0 },
  })
  assert.deepEqual(empty.current, { totalViews: 0, productsViewed: 0, sessions: 0, viewsPerSession: null })
})

test("datos incoherentes de un período: ese período queda sin comparar (null), nunca un porcentaje inventado", () => {
  const range = { from: "2026-10-21", to: "2026-10-27" }
  const valid = { totalViews: 10, productsViewed: 3, sessions: 4 }
  for (const previous of [
    { totalViews: 5, productsViewed: 6, sessions: 1 },
    { totalViews: 5, productsViewed: 1, sessions: 6 },
    { totalViews: 5, productsViewed: 0, sessions: 1 },
    { totalViews: 0, productsViewed: 0, sessions: 1 },
    { totalViews: Number.NaN, productsViewed: 1, sessions: 1 },
    { totalViews: -1, productsViewed: 0, sessions: 0 },
  ]) {
    const report = buildPeriodComparisonReport(range, { current: valid, previous })
    assert.equal(report.previous, null, JSON.stringify(previous))
    assert.ok(report.current)
  }
  assert.deepEqual(buildPeriodComparisonReport(range, null).current, null)
})
