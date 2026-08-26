import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), "utf8")
}

test("admin: 'Generar envío' ya no bloquea sucursal incondicionalmente -- exige sucursal persistida, no dirección del cliente", () => {
  const admin = source("app/admin/sections/pedidos/admin-pedidos.tsx")

  assert.match(admin, /function getAndreaniShipmentBlockingReason\(/)
  assert.doesNotMatch(admin, /Andreani solo aplica a envíos a domicilio/)
  assert.match(admin, /pedido\.shipping_type === "sucursal"/)
  assert.match(admin, /!pedido\.andreani_sucursal_id/)
  assert.match(admin, /hasRecipientContactData/)
})

test("admin: el destino de un pedido sucursal muestra la sucursal Andreani real, nunca la dirección del cliente", () => {
  const admin = source("app/admin/sections/pedidos/admin-pedidos.tsx")

  assert.match(admin, /function BranchDeliveryDetails\(/)
  assert.match(admin, /andreani_sucursal_nombre/)
  assert.match(admin, /andreani_sucursal_direccion/)
  // No inventa destino si el pedido histórico no tiene sucursal persistida.
  assert.match(admin, /Falta seleccionar\/persistir sucursal Andreani/)
  // El dispatcher de destino deriva a BranchDeliveryDetails para sucursal.
  assert.match(
    admin,
    /if \(pedido\.shipping_type === "sucursal"\) \{\s*\n\s*return <BranchDeliveryDetails/,
  )
})

test("admin: BranchDeliveryDetails no muestra el idgla como dato principal", () => {
  const admin = source("app/admin/sections/pedidos/admin-pedidos.tsx")
  const start = admin.indexOf("function BranchDeliveryDetails(")
  const end = admin.indexOf("function ShippingAddressDetails(")
  assert.ok(start >= 0 && end > start, "no se pudo delimitar BranchDeliveryDetails")
  const component = admin.slice(start, end)

  assert.doesNotMatch(component, /andreani_sucursal_id/)
})

test("admin: no existe ningún editor que permita cambiar shipping_type después de creado el pedido (auditado: sólo se lee, nunca se escribe)", () => {
  const admin = source("app/admin/sections/pedidos/admin-pedidos.tsx")

  assert.doesNotMatch(admin, /shipping_type:\s*value/)
  assert.doesNotMatch(admin, /setShippingType/)
  assert.doesNotMatch(admin, /onShippingTypeChange/)
})

test("cliente (detalle): la entrega en sucursal muestra sucursal/dirección reales, nunca el andreani_sucursal_id como dato visible", () => {
  const client = source("app/cuenta/cuenta-client.tsx")

  assert.match(client, /order\.shipping_type === "sucursal" && \(/)
  assert.match(client, /Entrega: Sucursal Andreani/)
  assert.match(client, /order\.andreani_sucursal_nombre/)
  assert.match(client, /order\.andreani_sucursal_direccion/)
  assert.match(client, /order\.andreani_sucursal_localidad/)
  assert.match(client, /order\.andreani_sucursal_provincia/)
  assert.match(client, /order\.andreani_sucursal_cp/)
  assert.doesNotMatch(client, /andreani_sucursal_id/)
  // Pedidos históricos sin sucursal persistida quedan marcados, no inventados.
  assert.match(client, /Falta seleccionar\/persistir la sucursal Andreani/)
})

test("el detalle del cliente (/api/orders/[id]) expone los campos de sucursal necesarios para mostrar, pero no el idgla ni el contrato", () => {
  const route = source("app/api/orders/[id]/route.ts")
  const selectMatch = route.match(
    /const CUSTOMER_ORDER_DETAIL_SELECT =\s*\n?\s*"([^"]+)"/,
  )
  assert.ok(selectMatch, "no se encontró CUSTOMER_ORDER_DETAIL_SELECT")
  const select = selectMatch![1]

  for (const field of [
    "andreani_sucursal_nombre",
    "andreani_sucursal_direccion",
    "andreani_sucursal_localidad",
    "andreani_sucursal_provincia",
    "andreani_sucursal_cp",
    "shipping_type",
  ]) {
    assert.match(select, new RegExp(field))
  }
  assert.doesNotMatch(select, /andreani_sucursal_id/)
  assert.doesNotMatch(select, /andreani_sucursal_codigo/)
  assert.doesNotMatch(select, /andreani_contrato/)
  assert.doesNotMatch(select, /andreani_envio_id/)
})
