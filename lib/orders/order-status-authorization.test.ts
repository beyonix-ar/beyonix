import assert from "node:assert/strict"
import test from "node:test"

import { canChangeOrderStatus } from "./order-status-authorization.ts"

test("operador puede aplicar una transición no reservada (ej. pagado)", () => {
  assert.equal(canChangeOrderStatus("operador", "pagado"), true)
})

test("operador NO puede forzar en_camino", () => {
  assert.equal(canChangeOrderStatus("operador", "en_camino"), false)
})

test("operador NO puede forzar entregado", () => {
  assert.equal(canChangeOrderStatus("operador", "entregado"), false)
})

test("admin tampoco puede forzar en_camino ni entregado (la política es exclusiva de super_admin)", () => {
  assert.equal(canChangeOrderStatus("admin", "en_camino"), false)
  assert.equal(canChangeOrderStatus("admin", "entregado"), false)
})

test("super_admin puede forzar en_camino y entregado", () => {
  assert.equal(canChangeOrderStatus("super_admin", "en_camino"), true)
  assert.equal(canChangeOrderStatus("super_admin", "entregado"), true)
})

test("cualquier rol interno puede aplicar transiciones no reservadas (cancelado, retiro_pendiente, etc.)", () => {
  for (const role of ["operador", "admin", "super_admin"]) {
    assert.equal(canChangeOrderStatus(role, "cancelado"), true)
    assert.equal(canChangeOrderStatus(role, "retiro_pendiente"), true)
  }
})
