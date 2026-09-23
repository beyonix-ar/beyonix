import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

function readSource(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8")
}

test("/checkout/failure conserva la acción principal 'Volver al checkout'", () => {
  const source = readSource("./page.tsx")

  assert.match(source, /href="\/checkout"/)
  assert.match(source, /Volver al checkout/)
})

test("/checkout/failure agrega la acción secundaria 'Volver a la tienda' -> /productos (no al home)", () => {
  const source = readSource("./page.tsx")

  assert.match(source, /href="\/productos"/)
  assert.match(source, /Volver a la tienda/)
  assert.doesNotMatch(source, /href="\/"\s*>/)
})

test("/checkout/failure no afirma categóricamente que no hubo cobro -- copy técnicamente defendible", () => {
  const source = readSource("./page.tsx")

  assert.doesNotMatch(source, /no se realizó ningún cobro/i)
  assert.doesNotMatch(source, /no se realiz[oó] ning[uú]n cargo/i)
})

test("/checkout/failure mantiene la identidad visual BEYONIX (shell compartido con success/pending)", () => {
  const source = readSource("./page.tsx")

  assert.match(source, /CheckoutStatusShell/)
  assert.match(source, /CheckoutStatusCard/)
  assert.match(source, /tone="failure"/)
})
