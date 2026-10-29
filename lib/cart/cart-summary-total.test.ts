import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  CART_SHIPPING_PENDING_NOTE,
  getCartSummaryTotalPresentation,
} from "./cart-summary-total.ts"

test("con envío a definir el importe del carrito es un subtotal estimado con aclaración", () => {
  assert.deepEqual(getCartSummaryTotalPresentation(false), {
    label: "Subtotal estimado",
    note: CART_SHIPPING_PENDING_NOTE,
  })
  assert.equal(CART_SHIPPING_PENDING_NOTE, "El envío se calcula en el checkout.")
})

test("con envío a cargo de BEYONIX (saldo a favor) el importe sí es el total", () => {
  assert.deepEqual(getCartSummaryTotalPresentation(true), { label: "Total", note: null })
})

test("CartSummary usa la presentación derivada y no cambia el importe mostrado", () => {
  const source = readFileSync(new URL("../../components/cart/cart-summary.tsx", import.meta.url), "utf8")

  assert.match(source, /getCartSummaryTotalPresentation\(shippingCoveredByBeyonix\)/)
  assert.match(source, /\{totalPresentation\.label\}/)
  assert.match(source, /\{totalPresentation\.note\}/)
  assert.match(source, /formatPrice\(creditApplication\.externalAmountDue\)/)
  assert.doesNotMatch(source, />Total</)
})

test("carrito vacío mantiene el mensaje y agrega \"Explorar productos\" hacia /productos", () => {
  const source = readFileSync(new URL("../../components/cart/cart-drawer.tsx", import.meta.url), "utf8")

  assert.match(source, /Tu carrito está vacío/)
  assert.match(source, /Explorar productos/)
  assert.match(source, /router\.push\("\/productos"\)/)
})
