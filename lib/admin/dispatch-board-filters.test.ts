import assert from "node:assert/strict"
import test from "node:test"
import { defaultDispatchFilters, dispatchFilterParams, dispatchPageCount, dispatchToday } from "./dispatch-board-filters"

const today = "2026-10-18"

test("Pendientes conserva abiertos de cualquier fecha; Confirmados y Entregados arrancan hoy", () => {
  assert.equal(dispatchToday(new Date("2026-10-18T15:00:00Z")), today)
  assert.deepEqual(["armado", "ready", "open", "delivered"].map((tab) => defaultDispatchFilters(tab as "armado" | "ready" | "open" | "delivered", today).dateFrom), ["", today, "", today])
  assert.deepEqual(["armado", "ready", "open", "delivered"].map((tab) => defaultDispatchFilters(tab as "armado" | "ready" | "open" | "delivered", today).dateTo), ["", today, "", today])
})

test("fecha histórica, rango, operador, estado, cantidad y búsqueda permanecen en la página solicitada", () => {
  const filters = { ...defaultDispatchFilters("delivered", today), search: "BX-1012", dateFrom: "2026-10-15", dateTo: "2026-10-18", batch: "Bulto - 0007", operator: "María", state: "Entregado", quantityKind: "parcels", quantityMin: "2", quantityMax: "5", tracking: "36000", hasRemoved: "true" }
  const params = new URLSearchParams(dispatchFilterParams("delivered", filters, 3))
  assert.equal(params.get("page"), "3")
  assert.equal(params.get("dateFrom"), "2026-10-15")
  assert.equal(params.get("dateTo"), "2026-10-18")
  assert.equal(params.get("operator"), "María")
  assert.equal(params.get("batch"), "Bulto - 0007")
  assert.equal(params.get("quantityKind"), "parcels")
  assert.equal(params.get("quantityMin"), "2")
  assert.equal(params.get("quantityMax"), "5")
  assert.equal(params.get("tracking"), "36000")
  assert.equal(params.get("hasRemoved"), "true")
  assert.equal(params.get("search"), "BX-1012")
})

test("Limpiar restaura defaults y Todas permite quitar el límite de fecha", () => {
  const defaults = defaultDispatchFilters("ready", today)
  assert.equal(new URLSearchParams(dispatchFilterParams("ready", defaults, 1)).get("dateFrom"), today)
  const allDates = new URLSearchParams(dispatchFilterParams("ready", { ...defaults, dateFrom: "", dateTo: "" }, 1))
  assert.equal(allDates.get("allDates"), "true")
  assert.equal(allDates.get("dateFrom"), null)
  assert.equal(defaultDispatchFilters("ready", today).dateFrom, today)
  assert.equal(dispatchPageCount(0), 1)
  assert.equal(dispatchPageCount(20), 1)
  assert.equal(dispatchPageCount(21), 2)
})
