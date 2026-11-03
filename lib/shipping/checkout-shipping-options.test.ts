import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  getCheckoutShippingOptionKey,
  isCheckoutShippingSelectionLost,
  keepPendingLocalDeliverySelection,
  LOCAL_DELIVERY_OPTION_KEY,
  resolveCheckoutShippingSelection,
  sortCheckoutShippingOptions,
  type CheckoutShippingOptionKey,
} from "./checkout-shipping-options.ts"

const opt = (key: CheckoutShippingOptionKey) => ({ key })
const ANDREANI_HOME = getCheckoutShippingOptionKey("andreani", "domicilio")
const ANDREANI_BRANCH = getCheckoutShippingOptionKey("andreani", "sucursal")

test("identidad provider+modality: Envío BEYONIX y Andreani domicilio son opciones distintas", () => {
  assert.equal(LOCAL_DELIVERY_OPTION_KEY, "beyonix:domicilio")
  assert.equal(ANDREANI_HOME, "andreani:domicilio")
  assert.notEqual(LOCAL_DELIVERY_OPTION_KEY, ANDREANI_HOME)
})

test("F. orden fijo: Envío BEYONIX → Andreani domicilio → Andreani sucursal", () => {
  const sorted = sortCheckoutShippingOptions([opt(ANDREANI_BRANCH), opt(ANDREANI_HOME), opt(LOCAL_DELIVERY_OPTION_KEY)])
  assert.deepEqual(sorted.map((option) => option.key), ["beyonix:domicilio", "andreani:domicilio", "andreani:sucursal"])
  // Sin CP elegible sólo queda Andreani, en su orden de siempre.
  assert.deepEqual(sortCheckoutShippingOptions([opt(ANDREANI_BRANCH), opt(ANDREANI_HOME)]).map((option) => option.key),
    ["andreani:domicilio", "andreani:sucursal"])
})

test("sin elección previa se sugiere Envío BEYONIX si se ofrece; si no, Andreani domicilio", () => {
  assert.equal(resolveCheckoutShippingSelection(null, [opt(ANDREANI_HOME), opt(LOCAL_DELIVERY_OPTION_KEY)]), LOCAL_DELIVERY_OPTION_KEY)
  assert.equal(resolveCheckoutShippingSelection(null, [opt(ANDREANI_BRANCH), opt(ANDREANI_HOME)]), ANDREANI_HOME)
  assert.equal(resolveCheckoutShippingSelection(null, []), null)
})

test("una elección vigente se conserva (incluida Andreani aunque Envío BEYONIX esté disponible)", () => {
  const options = [opt(LOCAL_DELIVERY_OPTION_KEY), opt(ANDREANI_HOME), opt(ANDREANI_BRANCH)]
  assert.equal(resolveCheckoutShippingSelection(ANDREANI_BRANCH, options), ANDREANI_BRANCH)
  assert.equal(resolveCheckoutShippingSelection(LOCAL_DELIVERY_OPTION_KEY, options), LOCAL_DELIVERY_OPTION_KEY)
})

test("cambio de CP a uno no habilitado: Envío BEYONIX desaparece y la selección queda inválida, sin pasar sola a Andreani", () => {
  const andreaniOnly = [opt(ANDREANI_HOME), opt(ANDREANI_BRANCH)]
  const kept = resolveCheckoutShippingSelection(LOCAL_DELIVERY_OPTION_KEY, andreaniOnly)
  // Queda pendiente: no coincide con ninguna opción visible → no hay envío elegido.
  assert.equal(kept, LOCAL_DELIVERY_OPTION_KEY)
  assert.equal(andreaniOnly.some((option) => option.key === kept), false)
  assert.equal(isCheckoutShippingSelectionLost(kept, andreaniOnly), true)
  // Al reiniciar el destino (CP incompleto) la elección pendiente no se borra:
  assert.equal(keepPendingLocalDeliverySelection(LOCAL_DELIVERY_OPTION_KEY), LOCAL_DELIVERY_OPTION_KEY)
  // ...pero una de Andreani sí (comportamiento previo).
  assert.equal(keepPendingLocalDeliverySelection(ANDREANI_HOME), null)
  // Cuando el cliente elige otra opción, deja de estar perdida.
  assert.equal(isCheckoutShippingSelectionLost(ANDREANI_HOME, andreaniOnly), false)
})

test("una opción de Andreani que ya no existe vuelve a la sugerida (comportamiento previo de Andreani)", () => {
  assert.equal(resolveCheckoutShippingSelection(ANDREANI_BRANCH, [opt(ANDREANI_HOME)]), ANDREANI_HOME)
})

test("checkout: Envío BEYONIX no depende de la cotización de Andreani y envía proveedor + importe visto, sin token", () => {
  const page = readFileSync("app/checkout/page.tsx", "utf8").replace(/\r\n/g, "\n")
  // Se calcula con la configuración pública + CP + subtotal de productos.
  assert.match(page, /quoteLocalDelivery\(siteSettings\.localDelivery, formData\.cpDestino, baseTotals\.productsTotal\)/)
  // La opción se muestra aunque Andreani falle: se arma aparte de shippingOptions.
  assert.match(page, /localDeliveryOption \? \[localDeliveryOption, \.\.\.shippingOptions\] : shippingOptions/)
  // Un error/carga de Andreani no bloquea continuar con Envío BEYONIX.
  assert.match(page, /\(isLocalDeliverySelected \|\| \(shippingQuoteCurrent && !shippingLoading\)\)/)
  // Selección por clave única.
  assert.match(page, /selectedShippingKey === option\.key/)
  assert.doesNotMatch(page, /setSelectedShippingType/)
  // Payload: proveedor + modalidad + importe visto (el servidor recalcula).
  assert.match(page, /expectedCostCharged: selectedShippingOption\.price/)
  // El saldo a favor no vuelve gratis a Envío BEYONIX.
  assert.match(page, /customerCreditIncludesShippingBenefit &&\n\s+hasAndreaniQuote &&/)
  assert.match(page, /const hasAndreaniQuote = !isLocalDeliverySelected/)
  // 409 de Envío BEYONIX: se relee la configuración y no se crea el pedido.
  assert.match(page, /response\.status === 409 && isLocalDeliverySelected && !data\?\.code[\s\S]{0,200}refreshCommercialData\(true\)/)
})
