import assert from "node:assert/strict"
import test from "node:test"

import { buildPeakHourReport, formatHourRange } from "./peak-hour-report.ts"

const RANGE = { from: "2026-10-20", to: "2026-10-26" }

test("franja horaria: 24 franjas de una hora, la última cierra en 00:00", () => {
  assert.equal(formatHourRange(0), "00:00 – 01:00")
  assert.equal(formatHourRange(9), "09:00 – 10:00")
  assert.equal(formatHourRange(14), "14:00 – 15:00")
  assert.equal(formatHourRange(23), "23:00 – 00:00")
})

test("reporte: hora pico, visualizaciones y porcentaje del período", () => {
  const report = buildPeakHourReport(RANGE, { hour: 14, views: 28, totalViews: 155 })
  assert.equal(report.totalViews, 155)
  assert.equal(report.peak?.hour, 14)
  assert.equal(report.peak?.views, 28)
  assert.ok(Math.abs(report.peak!.sharePercent - (28 / 155) * 100) < 1e-9)
})

test("sin datos o datos incoherentes: peak null (nunca 00:00 con 0)", () => {
  for (const row of [
    null,
    { hour: 0, views: 0, totalViews: 0 },
    { hour: 24, views: 3, totalViews: 3 },
    { hour: 1.5, views: 3, totalViews: 3 },
    { hour: 3, views: 5, totalViews: 4 },
    { hour: 3, views: Number.NaN, totalViews: 4 },
  ]) {
    assert.deepEqual(buildPeakHourReport(RANGE, row), { range: RANGE, totalViews: 0, peak: null }, JSON.stringify(row))
  }
})
