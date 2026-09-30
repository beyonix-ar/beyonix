import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { FreeShippingBar } from "@/components/cart/free-shipping-bar"
import type { ShippingBonusSettings } from "@/lib/store-config"

// Tope de bonificación de envío: una sola fuente, la configuración de Admin
// (site_settings.shipping.shippingBonusMax). El carrito NO lo muestra;
// Términos y condiciones lo lee de esa misma configuración y refleja
// cualquier cambio.

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&nbsp;| /g, " ").replace(/\s+/g, " ").trim()
const ars = (value: number) =>
  new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", minimumFractionDigits: 0 }).format(value).replace(/ /g, " ")

const SETTINGS: ShippingBonusSettings = {
  defaultShippingCost: 0,
  freeShippingMinAmount: 75_000,
  shippingBonusMax: 20_000,
  freeShippingMode: "full",
  logisticsBaseSubsidy: 3_000,
}

test("E. carrito con envío bonificado: 'Tenés envío bonificado', sin 'hasta $…' ni el tope", () => {
  for (const shippingBonusMax of [20_000, 15_000, 30_000]) {
    const html = renderToStaticMarkup(
      createElement(FreeShippingBar, { subtotal: 90_000, settings: { ...SETTINGS, shippingBonusMax } }),
    )
    const copy = text(html)
    assert.match(copy, /Tenés envío bonificado/)
    assert.doesNotMatch(copy, /hasta/i)
    assert.doesNotMatch(copy, /\$/)
    assert.equal(copy.includes(ars(shippingBonusMax)), false)
  }
})

test("con cotización real sigue mostrando el ahorro real (no el tope)", () => {
  const copy = text(renderToStaticMarkup(
    createElement(FreeShippingBar, { subtotal: 90_000, settings: SETTINGS, shippingCostReal: 25_000, shippingBonus: 20_000 }),
  ))
  assert.match(copy, /Ahorrás \$\s?20\.000 en tu envío/)
})

// El lado de Términos (misma configuración y cambios reflejados) está en
// shipping-bonus-terms.test.ts.
test("sin constantes paralelas: el carrito no usa ni muestra el tope (SHIPPING_BONUS_MAX es sólo el default de la configuración)", async () => {
  const { readFileSync } = await import("node:fs")
  // Sólo código: los comentarios pueden nombrar la configuración de origen.
  const code = readFileSync("components/cart/free-shipping-bar.tsx", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
  assert.doesNotMatch(code, /SHIPPING_BONUS_MAX|shippingBonusMax|20[._]?000/)
})
