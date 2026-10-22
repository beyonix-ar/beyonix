import assert from "node:assert/strict"
import test from "node:test"
import { dispatchLocationFromSearch, dispatchLocationHref, parseDispatchLocation } from "./dispatch-location"
import { defaultDispatchRecordFilters, dispatchRecordParams, dispatchToday, restoreDispatchRecordsView } from "./dispatch-records"

test("URL estable de Despachos: pedido y Bulto sobreviven a refrescar y volver; ?tab viejo se ignora", () => {
  assert.deepEqual(dispatchLocationFromSearch("?tab=ready&order=11"), { orderId: 11, batchId: null })
  assert.equal(dispatchLocationHref({ orderId: 11, batchId: null }), "/admin/despachos?order=11")
  assert.equal(dispatchLocationHref({ orderId: null, batchId: 5 }), "/admin/despachos?batch=5")
  assert.equal(dispatchLocationHref({ orderId: null, batchId: null }), "/admin/despachos")
  assert.deepEqual(dispatchLocationFromSearch("?tab=open&batch=5"), { orderId: null, batchId: 5 })
  assert.deepEqual(parseDispatchLocation({ order: "11" }), { orderId: 11, batchId: null })
  for (const invalid of ["?tab=otra&order=-1", "?order=abc&batch=0", "?order=1e3", "?batch=99999999999999999"]) {
    assert.deepEqual(dispatchLocationFromSearch(invalid), { orderId: null, batchId: null }, invalid)
  }
})

test("filtros: fecha por defecto hoy, parámetros sin vacíos y restauración validada", () => {
  assert.deepEqual(defaultDispatchRecordFilters("2026-10-22"), { date: "2026-10-22", manualDate: false, order: "", batch: "", user: "", state: "" })
  assert.match(dispatchToday(new Date("2026-10-23T02:30:00Z")), /^2026-10-22$/, "hoy en Buenos Aires")
  // Hoy por defecto sólo recorta lo resuelto; una fecha elegida a mano filtra todo.
  assert.equal(dispatchRecordParams({ date: "2026-10-22", manualDate: false, order: " BX-1012 ", batch: "", user: "", state: "P" }, 2), "page=2&date=2026-10-22&order=BX-1012&state=P&openAllDates=true")
  assert.equal(dispatchRecordParams({ ...defaultDispatchRecordFilters("2026-10-22"), date: "2026-10-20", manualDate: true }, 1), "page=1&date=2026-10-20")
  assert.equal(dispatchRecordParams({ ...defaultDispatchRecordFilters("2026-10-22"), date: "", manualDate: true }, 1), "page=1", "sin fecha: todo")
  const stored = (today: string, filters: Record<string, unknown>, page: unknown = 3) => JSON.stringify({ today, filters, page })
  const view = restoreDispatchRecordsView(stored("2026-10-22", { date: "2026-10-20", manualDate: true, order: "BX-1011", user: "María Ñúñez", state: "E" }), "2026-10-22")
  assert.deepEqual([view.filters.date, view.filters.manualDate, view.filters.order, view.filters.state, view.page], ["2026-10-20", true, "BX-1011", "E", 3])
  assert.equal(restoreDispatchRecordsView(stored("2026-10-22", { state: "A", manualDate: "sí" }), "2026-10-22").filters.state, "", "Anulado ya no es un estado")
  assert.equal(restoreDispatchRecordsView(stored("2026-10-22", { manualDate: "sí" }), "2026-10-22").filters.manualDate, false)
  assert.deepEqual(restoreDispatchRecordsView(stored("2026-10-21", { date: "2026-10-21", order: "BX-1" }), "2026-10-22").filters, defaultDispatchRecordFilters("2026-10-22"), "guardado ayer: vuelve a hoy")
  const broken = restoreDispatchRecordsView(stored("2026-10-22", { date: "ayer", state: "Z", batch: 7 }, -1), "2026-10-22")
  assert.deepEqual([broken.filters.date, broken.filters.state, broken.filters.batch, broken.page], ["2026-10-22", "", "", 1])
  for (const raw of [null, "", "{", "[]", "\"x\""]) assert.equal(restoreDispatchRecordsView(raw, "2026-10-22").filters.date, "2026-10-22")
})
