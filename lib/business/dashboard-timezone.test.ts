import assert from "node:assert/strict"
import test from "node:test"

import {
  argentinaDateKey,
  isSameArgentinaDay,
  matchesArgentinaMetricMonth,
  matchesArgentinaMetricYear,
} from "./dashboard-timezone.ts"

test("P. una venta a las 23:30 de Argentina cae en el día, mes y año local correctos", () => {
  const sale = "2026-01-01T02:30:00.000Z" // 31/12/2025 23:30 en Argentina
  const localReference = "2025-12-31T15:00:00.000-03:00"
  assert.equal(argentinaDateKey(sale), "2025-12-31")
  assert.equal(isSameArgentinaDay(sale, localReference), true)
  assert.equal(matchesArgentinaMetricMonth(sale, "11", "2025", localReference), true)
  assert.equal(matchesArgentinaMetricYear(sale, "2025", localReference), true)
})
