import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

function readSource(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8")
}

test("/checkout/pending lleva a Mis compras con la ruta real de cuenta", () => {
  const source = readSource("./page.tsx")

  assert.match(source, /href="\/cuenta\?tab=ordenes"/)
  assert.match(source, /Ir a Mis compras/)
  assert.match(source, /Podés seguir el estado desde Mis compras\./)
})

test("/checkout/pending no arma una URL de pedido dudosa (Mercado Pago no trae un id confiable)", () => {
  const source = readSource("./page.tsx")

  assert.doesNotMatch(source, /\/cuenta\/compras\/\$\{/)
  assert.doesNotMatch(source, /searchParams/)
})

test("/checkout/pending conserva \"Volver al inicio\" y el shell compartido", () => {
  const source = readSource("./page.tsx")

  assert.match(source, /href="\/"/)
  assert.match(source, /Volver al inicio/)
  assert.match(source, /CheckoutStatusShell/)
  assert.match(source, /tone="pending"/)
})
