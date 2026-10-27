import assert from "node:assert/strict"
import test from "node:test"

import {
  buildPeakHourReport,
  buildHourlyViewsReport,
  buildPeakWeekdayReport,
  buildWeekdayViewsReport,
  formatHourRange,
  formatWeekday,
  formatWeekdayShort,
} from "./peak-views-report.ts"

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

test("por día de la semana: abreviaturas con tildes, de lunes a domingo", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map(formatWeekdayShort), ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"])
})

test("por día de la semana: siempre 7 días en orden, los faltantes con 0, porcentaje sobre el total", () => {
  const report = buildWeekdayViewsReport(RANGE, [{ weekday: 6, views: 210 }, { weekday: 1, views: 110 }, { weekday: 3, views: 145 }])
  assert.equal(report.totalViews, 465)
  assert.deepEqual(report.days.map((day) => [day.weekday, day.views]), [[1, 110], [2, 0], [3, 145], [4, 0], [5, 0], [6, 210], [7, 0]])
  assert.ok(Math.abs(report.days[2].sharePercent - (145 / 465) * 100) < 1e-9)
  assert.equal(report.days[1].sharePercent, 0)
  assert.ok(Math.abs(report.days.reduce((sum, day) => sum + day.sharePercent, 0) - 100) < 1e-9)
})

test("por día de la semana: sin vistas → 7 ceros con 0%; filas inválidas se descartan", () => {
  const empty = buildWeekdayViewsReport(RANGE, [])
  assert.equal(empty.totalViews, 0)
  assert.deepEqual(empty.days.map((day) => [day.weekday, day.views, day.sharePercent]), [1, 2, 3, 4, 5, 6, 7].map((weekday) => [weekday, 0, 0]))
  const invalid = buildWeekdayViewsReport(RANGE, [{ weekday: 0, views: 5 }, { weekday: 8, views: 5 }, { weekday: 2.5, views: 5 }, { weekday: 4, views: Number.NaN }, { weekday: 5, views: -3 }, { weekday: 2, views: 7 }])
  assert.equal(invalid.totalViews, 7)
  assert.deepEqual(invalid.days.map((day) => day.views), [0, 7, 0, 0, 0, 0, 0])
})

test("por hora del día: siempre 24 horas en orden (00 a 23), las faltantes con 0, porcentaje sobre el total", () => {
  const report = buildHourlyViewsReport(RANGE, [{ hour: 20, views: 45 }, { hour: 0, views: 2 }, { hour: 9, views: 27 }, { hour: 23, views: 6 }, { hour: 8, views: 15 }, { hour: 10, views: 42 }, { hour: 2, views: 1 }, { hour: 18, views: 112 }])
  assert.equal(report.totalViews, 250)
  assert.deepEqual(report.hours.map((slot) => slot.hour), Array.from({ length: 24 }, (_, hour) => hour))
  const views = Object.fromEntries(report.hours.map((slot) => [slot.hour, slot.views]))
  assert.deepEqual([views[0], views[1], views[2], views[8], views[9], views[10], views[18], views[20], views[23]], [2, 0, 1, 15, 27, 42, 112, 45, 6])
  assert.equal(report.hours[20].sharePercent, 18, "45 de 250 = 18%")
  assert.equal(report.hours[1].sharePercent, 0)
  assert.ok(Math.abs(report.hours.reduce((sum, slot) => sum + slot.sharePercent, 0) - 100) < 1e-9)
})

test("por hora del día: sin vistas → 24 ceros con 0%; filas inválidas se descartan", () => {
  const empty = buildHourlyViewsReport(RANGE, [])
  assert.equal(empty.totalViews, 0)
  assert.deepEqual(empty.hours.map((slot) => [slot.hour, slot.views, slot.sharePercent]), Array.from({ length: 24 }, (_, hour) => [hour, 0, 0]))
  const invalid = buildHourlyViewsReport(RANGE, [{ hour: -1, views: 5 }, { hour: 24, views: 5 }, { hour: 3.5, views: 5 }, { hour: 4, views: Number.NaN }, { hour: 5, views: -3 }, { hour: 6, views: 7 }])
  assert.equal(invalid.totalViews, 7)
  assert.deepEqual(invalid.hours.filter((slot) => slot.views > 0).map((slot) => [slot.hour, slot.views, slot.sharePercent]), [[6, 7, 100]])
})
