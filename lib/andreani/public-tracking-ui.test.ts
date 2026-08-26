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

test("cliente (cuenta): el ícono de copiar está condicionado a que exista trackingNumber", () => {
  const source = readSource("../../app/cuenta/cuenta-client.tsx")

  assert.match(source, /\{trackingNumber && \(/)
  assert.match(source, /onClick=\{\(\) => void copyTrackingNumber\(trackingNumber\)\}/)
  assert.match(source, /title=\{trackingCopied \? "Copiado" : "Copiar seguimiento"\}/)
})

test("componente compartido OrderTrackingPanel: copiar está condicionado al tracking y no hardcodea ningún número", () => {
  const source = readSource(
    "../../components/account/account-order-components.tsx",
  )

  assert.match(source, /const \{ trackingNumber, url: trackingUrl \} = resolveOrderTrackingLink\(order\)/)
  assert.match(source, /\{trackingNumber && \(/)
  assert.doesNotMatch(source, /360003079278920/)
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
