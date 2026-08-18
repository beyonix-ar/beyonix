import assert from "node:assert/strict"
import test from "node:test"

import {
  canChangeDeliveredAt,
  isSameCalendarDay,
} from "./delivery-date-authorization.ts"

test("misma fecha (aunque cambie la hora exacta) se considera sin cambios", () => {
  assert.equal(
    isSameCalendarDay(
      "2026-01-15T14:32:07.123Z",
      "2026-01-15T00:00:00.000Z",
    ),
    true,
  )
})

test("null/null se considera sin cambios; null vs. una fecha sí es un cambio", () => {
  assert.equal(isSameCalendarDay(null, null), true)
  assert.equal(isSameCalendarDay(null, "2026-01-15T00:00:00.000Z"), false)
  assert.equal(isSameCalendarDay("2026-01-15T00:00:00.000Z", null), false)
})

test("un admin puede reenviar la misma fecha de entrega (edición de garantía sin tocar la entrega)", () => {
  assert.equal(
    canChangeDeliveredAt(
      "admin",
      "2026-01-15T00:00:00.000Z",
      "2026-01-15T00:00:00.000Z",
    ),
    true,
  )
})

test("operador NO puede establecer delivered_at por primera vez (equivale a marcar como entregado)", () => {
  assert.equal(canChangeDeliveredAt("operador", null, "2026-01-15T00:00:00.000Z"), false)
})

test("admin tampoco puede establecer delivered_at por primera vez (misma política que /status)", () => {
  assert.equal(canChangeDeliveredAt("admin", null, "2026-01-15T00:00:00.000Z"), false)
})

test("super_admin sí puede establecer delivered_at por primera vez", () => {
  assert.equal(canChangeDeliveredAt("super_admin", null, "2026-01-15T00:00:00.000Z"), true)
})

test("operador NO puede cambiar una fecha de entrega ya existente a otra fecha", () => {
  assert.equal(
    canChangeDeliveredAt(
      "operador",
      "2026-01-10T00:00:00.000Z",
      "2026-01-15T00:00:00.000Z",
    ),
    false,
  )
})

test("super_admin puede cambiar una fecha de entrega ya existente a otra fecha", () => {
  assert.equal(
    canChangeDeliveredAt(
      "super_admin",
      "2026-01-10T00:00:00.000Z",
      "2026-01-15T00:00:00.000Z",
    ),
    true,
  )
})

test("operador NO puede quitar (nulear) una fecha de entrega existente", () => {
  assert.equal(canChangeDeliveredAt("operador", "2026-01-10T00:00:00.000Z", null), false)
})
