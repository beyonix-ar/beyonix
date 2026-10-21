import assert from "node:assert/strict"
import test from "node:test"
import { dispatchLocationFromSearch, dispatchLocationHref, dispatchTabForStage, parseDispatchLocation, restoreDispatchBoardView } from "./dispatch-location"

test("URL estable de Despachos: pestaña, pedido y Bulto sobreviven a refrescar y volver", () => {
  assert.deepEqual(dispatchLocationFromSearch("?tab=ready&order=11"), { tab: "ready", orderId: 11, batchId: null })
  assert.equal(dispatchLocationHref({ tab: "ready", orderId: 11, batchId: null }), "/admin/despachos?tab=ready&order=11")
  assert.equal(dispatchLocationHref({ tab: "ready", orderId: null, batchId: null }), "/admin/despachos?tab=ready")
  assert.equal(dispatchLocationHref({ tab: null, orderId: null, batchId: null }), "/admin/despachos")
  assert.deepEqual(dispatchLocationFromSearch("?tab=open&batch=5"), { tab: "open", orderId: null, batchId: 5 })
  // Enlace directo desde Pedidos: sin pestaña, la etapa del pedido la define.
  assert.deepEqual(parseDispatchLocation({ order: "11" }), { tab: null, orderId: 11, batchId: null })
  for (const invalid of ["?tab=otra&order=-1", "?order=abc&batch=0", "?order=1e3", "?batch=99999999999999999"]) {
    assert.deepEqual(dispatchLocationFromSearch(invalid), { tab: null, orderId: null, batchId: null }, invalid)
  }
})

test("cada etapa del pedido vive en su pestaña", () => {
  assert.deepEqual((["pending", "packing", "shipment", "label", "ready", "in_batch", "batch_closed", "handed_over"] as const).map(dispatchTabForStage),
    ["armado", "armado", "armado", "ready", "ready", "open", "open", "delivered"])
})

test("filtros y página por pestaña: se restauran validados y 'hoy' nunca queda en una fecha vieja", () => {
  const stored = JSON.stringify({
    filters: {
      ready: { search: "BX-1011", dateMode: "day", dateFrom: "2026-10-20", dateTo: "2026-10-20", operator: "María Ñúñez" },
      delivered: { dateMode: "today", dateFrom: "2026-10-20", dateTo: "2026-10-20" },
      open: { dateMode: "otra", search: 7 },
    },
    pages: { ready: 3, armado: -2, open: 1.5 },
  })
  const view = restoreDispatchBoardView(stored, "2026-10-21")
  assert.deepEqual([view.filters.ready.search, view.filters.ready.dateFrom, view.filters.ready.operator], ["BX-1011", "2026-10-20", "María Ñúñez"])
  assert.deepEqual([view.filters.delivered.dateFrom, view.filters.delivered.dateTo], ["2026-10-21", "2026-10-21"])
  assert.deepEqual([view.filters.open.dateMode, view.filters.open.search], ["all", ""])
  assert.deepEqual(view.pages, { armado: 1, ready: 3, open: 1, delivered: 1 })
  assert.equal(view.filters.armado.dateFrom, "", "Pendientes sin fecha")
  assert.equal(view.filters.ready.quantityKind, "units")
  for (const broken of [null, "", "{", "[]", "\"x\""]) assert.equal(restoreDispatchBoardView(broken, "2026-10-21").filters.ready.dateFrom, "")
})
