import assert from "node:assert/strict"
import test from "node:test"

import { buildPeakHourReport, buildPeakWeekdayReport, formatHourRange, formatWeekday } from "./peak-views-report.ts"

const RANGE = { from: "2026-10-20", to: "2026-10-26" }

test("franja horaria: 24 franjas de una hora, la última cierra en 00:00", () => {
  assert.equal(formatHourRange(0), "00:00 – 01:00")
  assert.equal(formatHourRange(9), "09:00 – 10:00")
  assert.equal(formatHourRange(14), "14:00 – 15:00")
  assert.equal(formatHourRange(23), "23:00 – 00:00")
})

test("reporte: hora pico, visualizaciones y porcentaje del período", () => {
  const report = buildPeakHourReport(RANGE, { bucket: 14, views: 28, totalViews: 155 })
  assert.equal(report.totalViews, 155)
  assert.equal(report.peak?.hour, 14)
  assert.equal(report.peak?.views, 28)
  assert.ok(Math.abs(report.peak!.sharePercent - (28 / 155) * 100) < 1e-9)
})

test("sin datos o datos incoherentes: peak null (nunca 00:00 con 0)", () => {
  for (const row of [
    null,
    { bucket: 0, views: 0, totalViews: 0 },
    { bucket: 24, views: 3, totalViews: 3 },
    { bucket: 1.5, views: 3, totalViews: 3 },
    { bucket: 3, views: 5, totalViews: 4 },
    { bucket: 3, views: Number.NaN, totalViews: 4 },
  ]) {
    assert.deepEqual(buildPeakHourReport(RANGE, row), { range: RANGE, totalViews: 0, peak: null }, JSON.stringify(row))
  }
})

test("día de la semana: días ISO en español con tildes (1 = lunes … 7 = domingo)", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map(formatWeekday), ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"])
})

test("día con más visualizaciones: día, visualizaciones y porcentaje del período", () => {
  const report = buildPeakWeekdayReport(RANGE, { bucket: 6, views: 84, totalViews: 262 })
  assert.equal(report.totalViews, 262)
  assert.deepEqual([report.peak?.weekday, report.peak?.views], [6, 84])
  assert.ok(Math.abs(report.peak!.sharePercent - (84 / 262) * 100) < 1e-9)
  assert.equal(buildPeakWeekdayReport({ from: "2026-10-26", to: "2026-10-26" }, { bucket: 1, views: 30, totalViews: 30 }).peak?.sharePercent, 100, "Hoy: un solo día posible, 100%")
})

test("día con más visualizaciones: sin datos o datos incoherentes → peak null (nunca \"Lunes, 0\")", () => {
  for (const row of [
    null,
    { bucket: 1, views: 0, totalViews: 0 },
    { bucket: 0, views: 3, totalViews: 3 },
    { bucket: 8, views: 3, totalViews: 3 },
    { bucket: 2.5, views: 3, totalViews: 3 },
    { bucket: 3, views: 5, totalViews: 4 },
  ]) {
    assert.deepEqual(buildPeakWeekdayReport(RANGE, row), { range: RANGE, totalViews: 0, peak: null }, JSON.stringify(row))
  }
})
