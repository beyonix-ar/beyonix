import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

function readSource(relativePath: string) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8")
}

test("admin: el botón grande de copiar tracking (número como texto de botón) fue eliminado", () => {
  const source = readSource("../../app/admin/sections/pedidos/admin-pedidos.tsx")

  // Regresión: antes existía un botón separado en la fila de acciones que
  // renderizaba el número de tracking como su propio texto visible.
  assert.doesNotMatch(source, /\{pedidoTracking\.trackingNumber!?\}\s*\n\s*<\/button>/)
  assert.doesNotMatch(source, /\{orderTracking\.trackingNumber!?\}\s*\n\s*<\/button>/)
})

test("admin: el ícono de copiar vive dentro de la mini-card de Seguimiento, condicionado al tracking del pedido", () => {
  const source = readSource("../../app/admin/sections/pedidos/admin-pedidos.tsx")

  assert.match(source, /label="Seguimiento"/)
  assert.match(source, /action=\{\s*pedidoTracking\.trackingNumber \?/)
  assert.match(source, /title=\{trackingCopied \? "Copiado" : "Copiar seguimiento"\}/)
  // Ícono pequeño (size-5/size-3), no el botón h-8 de las demás acciones.
  assert.match(source, /size-5 shrink-0 cursor-pointer/)
})

test("admin: 'Ver envío' sigue siendo una acción separada de copiar tracking", () => {
  const source = readSource("../../app/admin/sections/pedidos/admin-pedidos.tsx")

  assert.match(source, /label="Ver envío"/)
  assert.match(source, /href=\{pedidoTracking\.url\}/)
})

test("cliente (cuenta): el detalle del pedido reutiliza el botón canónico de copiar, condicionado al trackingNumber real", () => {
  const source = readSource("../../app/cuenta/cuenta-client.tsx")

  assert.match(source, /trackingNumber \? \(/)
  assert.match(source, /<TrackingCopyButton\s+trackingNumber=\{trackingNumber\}/)
  // El bloque "Gestión del pedido" quedó compacto: sin línea separada de
  // transportista ni de "Código:".
  assert.doesNotMatch(source, /Código: \$\{trackingNumber\}/)
})

test("componente compartido TrackingCopyButton: único lugar con la lógica de portapapeles, sin hardcodear ningún número", () => {
  const source = readSource(
    "../../components/account/account-order-components.tsx",
  )

  assert.match(source, /export function TrackingCopyButton\(/)
  assert.match(source, /navigator\.clipboard\.writeText\(trackingNumber\)/)
  assert.doesNotMatch(source, /360003079278920/)
})

test("TrackingCopyButton muestra cursor pointer al pasar el mouse (se aplica en el único componente compartido)", () => {
  const source = readSource(
    "../../components/account/account-order-components.tsx",
  )

  const buttonMatch = source.match(
    /export function TrackingCopyButton\([\s\S]*?<button[\s\S]*?<\/button>/,
  )
  assert.ok(buttonMatch, "no se encontró el botón de TrackingCopyButton")
  assert.match(buttonMatch![0], /cursor-pointer/)
})

test("REGRESIÓN: OrderTrackingPanel y CustomerInvoiceBell (código muerto sin consumidores) no vuelven a aparecer", () => {
  const source = readSource(
    "../../components/account/account-order-components.tsx",
  )

  assert.doesNotMatch(source, /export function OrderTrackingPanel/)
  assert.doesNotMatch(source, /export function CustomerInvoiceBell/)
  assert.doesNotMatch(source, /DOWNLOADED_INVOICES_STORAGE_KEY/)
})

test("detalle del pedido: 'Número de seguimiento:' y el ícono de copiar son blancos, sin volverse negrita", () => {
  const source = readSource("../../app/cuenta/cuenta-client.tsx")

  assert.match(
    source,
    /<span className="text-xs font-normal text-white">\s*\n\s*Número de seguimiento:/,
  )
  assert.doesNotMatch(source, /text-beyonix-gray-500">\s*\n\s*Número de seguimiento:/)
  assert.match(
    source,
    /<TrackingCopyButton\s+trackingNumber=\{trackingNumber\}\s+className="text-white"\s*\/>/,
  )
  // El número en sí mantiene exactamente su estilo previo (blanco semibold).
  assert.match(source, /className="break-all text-sm font-semibold text-white"/)
})

test("detalle del pedido: 'Gestión del pedido' quedó compacta en una fila (número + copiar a la izquierda, botón a la derecha)", () => {
  const source = readSource("../../app/cuenta/cuenta-client.tsx")

  assert.match(source, /Número de seguimiento:/)
  // Ya no hay una línea separada mostrando el transportista ("Andreani")
  // ni el rótulo "Seguimiento" como encabezado propio de esa fila.
  assert.doesNotMatch(source, />\s*Seguimiento\s*<\/p>/)
  assert.match(source, /sm:flex-row sm:items-center sm:justify-between/)
})

test("Mis compras y el detalle nunca exponen andreani_envio_id ni el contrato en la UI del cliente", () => {
  for (const path of [
    "../../components/account/account-orders.tsx",
    "../../app/api/orders/route.ts",
  ]) {
    const source = readSource(path)
    assert.doesNotMatch(source, /andreani_envio_id/)
    assert.doesNotMatch(source, /andreani_contrato/)
  }
})

test("ningún archivo de UI de tracking hardcodea el número de tracking de la prueba real", () => {
  for (const path of [
    "../../app/admin/sections/pedidos/admin-pedidos.tsx",
    "../../app/cuenta/cuenta-client.tsx",
    "../../components/account/account-order-components.tsx",
    "../../lib/andreani/public-tracking.ts",
  ]) {
    const source = readSource(path)
    assert.doesNotMatch(source, /360003079278920/)
    assert.doesNotMatch(source, /API0000166738862/)
  }
})
