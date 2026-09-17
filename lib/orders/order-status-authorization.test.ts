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

test("cualquier rol interno puede aplicar transiciones no reservadas (retiro_pendiente, etc.)", () => {
  for (const role of ["operador", "admin", "super_admin"]) {
    assert.equal(canChangeOrderStatus(role, "retiro_pendiente"), true)
  }
})

test("BLOQUEANTE 1 (Parte 3): NINGÚN rol interno puede aplicar 'cancelado' vía el mecanismo genérico -- tiene su propio flujo dedicado", () => {
  for (const role of ["operador", "admin", "super_admin"]) {
    assert.equal(canChangeOrderStatus(role, "cancelado"), false)
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

test("BLOQUEANTE 1 (Parte 3): 'cancelado' se rechaza ANTES de leer el pedido -- ningún dato del pedido (claimed, reconciliation_required, envío ya creado, factura) puede evadir el bloqueo", () => {
  const route = readFileSync(
    new URL("../../app/api/admin/pedidos/[id]/status/route.ts", import.meta.url),
    "utf8",
  )

  assert.doesNotMatch(
    route,
    /ALLOWED_ORDER_STATUSES\s*=\s*\[[^\]]*"cancelado"/,
    "'cancelado' no debe volver a la lista de estados operativos permitidos",
  )

  const cancelBlockIndex = route.search(/estado === "cancelado"[\s\S]{0,40}return NextResponse\.json/)
  const orderReadIndex = route.indexOf('.from("ordenes")')
  assert.ok(cancelBlockIndex >= 0, "debe existir un rechazo explícito de 'cancelado'")
  assert.ok(orderReadIndex >= 0)
  assert.ok(
    cancelBlockIndex < orderReadIndex,
    "el rechazo de 'cancelado' debe ocurrir ANTES de leer el pedido -- así ningún dato (claimed, reconciliation_required, envío ya creado, facturado) puede cambiar el resultado",
  )
})

test("BLOQUEANTE 1 (Parte 3): la cancelación real sigue viviendo exclusivamente en admin_cancel_order (RPC con todas las guardas), nunca duplicada acá", () => {
  const statusRoute = readFileSync(
    new URL("../../app/api/admin/pedidos/[id]/status/route.ts", import.meta.url),
    "utf8",
  )
  const cancelRoute = readFileSync(
    new URL("../../app/api/admin/pedidos/[id]/cancel/route.ts", import.meta.url),
    "utf8",
  )

  assert.doesNotMatch(statusRoute, /rpc\(\s*\n?\s*"admin_cancel_order"/)
  assert.doesNotMatch(statusRoute, /reverseCustomerCreditForOrder|upsertCustomerCancelledOrderNotification/)
  assert.match(cancelRoute, /rpc\(\s*\n?\s*"admin_cancel_order"/)
})

test("estados físicos de Andreani (visita fallida, en sucursal, retiro, devolución) exigen un envío Andreani real cuando el transportista es Andreani", () => {
  const route = readFileSync(
    new URL("../../app/api/admin/pedidos/[id]/status/route.ts", import.meta.url),
    "utf8",
  )

  const physicalListMatch = route.match(/ANDREANI_PHYSICAL_STATUSES\s*=\s*\[([^\]]*)\]/)
  assert.ok(physicalListMatch, "debe existir la lista de estados físicos Andreani")

  for (const estado of [
    "visita_fallida",
    "en_sucursal",
    "retiro_pendiente",
    "retiro_vencido",
    "en_devolucion",
    "devuelto_beyonix",
  ]) {
    assert.match(physicalListMatch![1], new RegExp(`"${estado}"`))
  }
  // "enviado" queda deliberadamente afuera: también lo usa un transportista
  // manual ("Otro"), sin andreani_envio_id.
  assert.doesNotMatch(physicalListMatch![1], /"enviado"/)
  assert.match(route, /andreani_envio_id/)
  assert.match(route, /shipping_provider/)
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
