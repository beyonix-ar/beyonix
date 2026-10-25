import assert from "node:assert/strict"
import test from "node:test"
import type { DispatchStage } from "./dispatch"
import { dispatchStepHref, getNextDispatchStep } from "./dispatch-next-step"
import { defaultDispatchRecordFilters, dispatchRecordParams } from "./dispatch-records"

const order = (stage: DispatchStage, extra: { orderId?: number; blocked?: boolean; batchId?: number | null } = {}) =>
  getNextDispatchStep({ kind: "order", orderId: extra.orderId ?? 15, stage, blocked: extra.blocked ?? false, batchId: extra.batchId ?? null })
const batch = (status: string, blocked = false) => getNextDispatchStep({ kind: "batch", batchId: 9, status, blocked })

test("pedido: el siguiente paso sale del estado real, sin ids fijos", () => {
  for (const stage of ["pending", "packing", "shipment", "label"] as const) assert.deepEqual(order(stage), { screen: "current" }, `${stage}: sigue en la misma pantalla`)
  assert.deepEqual(order("ready"), { screen: "bundle_list", orderId: 15 }, "listo para Bulto")
  assert.deepEqual(order("ready", { orderId: 1234 }), { screen: "bundle_list", orderId: 1234 })
  assert.deepEqual(order("in_batch", { batchId: 9 }), { screen: "batch", batchId: 9 })
  assert.deepEqual(order("batch_closed", { batchId: 9 }), { screen: "batch", batchId: 9 })
  assert.deepEqual(order("in_batch"), { screen: "current" }, "sin Bulto conocido no inventa destino")
  assert.deepEqual(order("handed_over"), { screen: "list" })
  // Bloqueado o con cancelación: no avanza, la pantalla actual muestra qué resolver.
  assert.deepEqual(order("ready", { blocked: true }), { screen: "current" })
})

test("Bulto: incidencias primero; entregado vuelve a la tabla", () => {
  assert.deepEqual(batch("open"), { screen: "batch", batchId: 9 }, "creado: su control")
  assert.deepEqual(batch("closed"), { screen: "batch", batchId: 9 }, "listo: su QR final")
  assert.deepEqual(batch("handed_over"), { screen: "list" })
  for (const status of ["open", "closed", "handed_over"]) assert.deepEqual(batch(status, true), { screen: "batch", batchId: 9 }, `${status} con incidencia: sus pedidos a retirar`)
})

test("destinos: URL que representa el paso; el pedido confirmado vuelve a la tabla general", () => {
  assert.equal(dispatchStepHref({ screen: "current" }), null)
  assert.equal(dispatchStepHref({ screen: "batch", batchId: 9 }), "/admin/despachos?batch=9")
  assert.equal(dispatchStepHref({ screen: "list" }), "/admin/despachos")
  assert.equal(dispatchStepHref({ screen: "bundle_list", orderId: 15 }), "/admin/despachos")
  // Tabla general: pedidos y Bultos, sin estado ni tipo; pendientes y confirmados de cualquier día abierto.
  assert.equal(dispatchRecordParams(defaultDispatchRecordFilters("2026-10-24"), 1), "page=1&date=2026-10-24&openAllDates=true")
})
