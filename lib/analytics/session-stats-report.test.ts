import assert from "node:assert/strict"
import test from "node:test"

import { buildSessionStatsReport, formatViewsPerSession } from "./session-stats-report.ts"

const RANGE = { from: "2026-10-20", to: "2026-10-26" }

const shown = (totalViews: number, sessions: number) => {
  const report = buildSessionStatsReport(RANGE, { totalViews, sessions })
  return [report.sessions, formatViewsPerSession(report.viewsPerSession)]
}

test("sesiones y promedio: 1 sesión 1 vista, 2 sesiones 10 vistas, 3 sesiones 10 vistas", () => {
  assert.deepEqual(shown(1, 1), [1, "1"], "A")
  assert.deepEqual(shown(10, 2), [2, "5"], "B: entero sin decimales")
  assert.deepEqual(shown(10, 3), [3, "3,3"], "C: un decimal, coma española")
  assert.deepEqual(shown(5, 2), [2, "2,5"])
  assert.deepEqual(shown(16, 5), [5, "3,2"])
  assert.equal(buildSessionStatsReport(RANGE, { totalViews: 10, sessions: 3 }).totalViews, 10)
  assert.equal(formatViewsPerSession(1234.56), "1.234,6")
})

test("sin datos: 0 sesiones y \"—\" (nunca NaN, Infinity ni 0/0)", () => {
  const report = buildSessionStatsReport(RANGE, { totalViews: 0, sessions: 0 })
  assert.deepEqual(report, { range: RANGE, totalViews: 0, sessions: 0, viewsPerSession: null })
  assert.deepEqual(shown(0, 0), [0, "—"], "D")
  assert.deepEqual(buildSessionStatsReport(RANGE, null), report, "sin fila")
})

test("datos incoherentes se tratan como período sin vistas (sin dividir por cero)", () => {
  for (const row of [
    { totalViews: 5, sessions: 0 },
    { totalViews: 2, sessions: 3 },
    { totalViews: Number.NaN, sessions: 1 },
    { totalViews: 4, sessions: -1 },
    { totalViews: 4.5, sessions: 2 },
  ]) {
    assert.deepEqual(buildSessionStatsReport(RANGE, row), { range: RANGE, totalViews: 0, sessions: 0, viewsPerSession: null }, JSON.stringify(row))
  }
})
