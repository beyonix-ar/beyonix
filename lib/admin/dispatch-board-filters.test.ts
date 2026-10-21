import assert from "node:assert/strict"
import test from "node:test"
import { defaultDispatchFilters, dispatchDefaultDate, dispatchFilterParams, dispatchPageCount, dispatchToday } from "./dispatch-board-filters"

const today = "2026-10-18"

test("trabajo abierto sin fecha por defecto: Pendientes, Confirmados y Bultos; sólo Entregados arranca hoy", () => {
  assert.equal(dispatchToday(new Date("2026-10-18T15:00:00Z")), today)
  assert.deepEqual(["armado", "ready", "open", "delivered"].map((tab) => defaultDispatchFilters(tab as "armado" | "ready" | "open" | "delivered", today).dateFrom), ["", "", "", today])
  assert.deepEqual(["armado", "ready", "open", "delivered"].map((tab) => defaultDispatchFilters(tab as "armado" | "ready" | "open" | "delivered", today).dateTo), ["", "", "", today])
  const ready = new URLSearchParams(dispatchFilterParams("ready", defaultDispatchFilters("ready", today), 1))
  assert.equal(ready.get("dateFrom"), null, "Confirmados no manda fecha: muestra los de días anteriores")
  assert.equal(ready.get("allDates"), null)
  // La API tampoco agrega "hoy" a Pendientes/Confirmados/Bultos (BX-1011 preparado ayer sigue visible).
  assert.deepEqual((["armado", "ready", "open", "delivered"] as const).map((tab) => dispatchDefaultDate(tab, false, today)), [null, null, null, today])
  assert.equal(dispatchDefaultDate("delivered", true, today), null)
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

test("Limpiar restaura defaults, la fecha manual sigue filtrando y Todas quita el límite de Entregados", () => {
  const manual = new URLSearchParams(dispatchFilterParams("ready", { ...defaultDispatchFilters("ready", today), dateMode: "day", dateFrom: "2026-10-17", dateTo: "2026-10-17" }, 1))
  assert.deepEqual([manual.get("dateFrom"), manual.get("dateTo")], ["2026-10-17", "2026-10-17"])
  const defaults = defaultDispatchFilters("delivered", today)
  assert.equal(new URLSearchParams(dispatchFilterParams("delivered", defaults, 1)).get("dateFrom"), today)
  const allDates = new URLSearchParams(dispatchFilterParams("delivered", { ...defaults, dateFrom: "", dateTo: "" }, 1))
  assert.equal(allDates.get("allDates"), "true")
  assert.equal(allDates.get("dateFrom"), null)
  assert.equal(defaultDispatchFilters("delivered", today).dateFrom, today)
  assert.equal(dispatchPageCount(0), 1)
  assert.equal(dispatchPageCount(20), 1)
  assert.equal(dispatchPageCount(21), 2)
})
