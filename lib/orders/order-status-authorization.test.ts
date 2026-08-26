import assert from "node:assert/strict"
import test from "node:test"

import { canChangeOrderStatus } from "./order-status-authorization.ts"
import { readFileSync } from "node:fs"

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

test("el endpoint operativo no puede fabricar pago ni despacho sin evidencia financiera", () => {
  const route = readFileSync(
    new URL("../../app/api/admin/pedidos/[id]/status/route.ts", import.meta.url),
    "utf8",
  )

  assert.match(
    route,
    /\(estado === "pagado" \|\| DISPATCHED_ORDER_STATUSES\.includes\(estado\)\)[\s\S]*?!isOrderPaymentConfirmed\(currentOrder\)/,
  )
})

test("Factura C usa evidencia financiera y nunca el estado operativo como prueba de pago", () => {
  const route = readFileSync(
    new URL("../../app/api/admin/orders/[id]/invoice/route.ts", import.meta.url),
    "utf8",
  )

  assert.match(route, /isOrderPaymentConfirmed\(order\)/)
  assert.doesNotMatch(route, /function isPaymentConfirmed/)

  const pendingChangeCheck = route.indexOf(
    'order.order_change_status === "change_requested"',
  )
  const invoiceClaim = route.indexOf('rpc("begin_arca_invoice_processing"')
  assert.ok(pendingChangeCheck >= 0 && invoiceClaim >= 0)
  assert.ok(
    pendingChangeCheck < invoiceClaim,
    "los cambios pendientes deben rechazarse antes de dejar invoice_status en processing",
  )
})
