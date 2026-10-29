import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  PRICING_CHANGED_UNKNOWN_NOTICE,
  diffCommercialSettings,
  getCommercialChangeCause,
  getCommercialUpdateNotice,
  getPricingChangedNotice,
  reconcileCartWithCatalog,
  type CommercialChangeSignals,
  type RefreshableCartItem,
} from "./cart-catalog-refresh.ts"
import { calculateCartTotals } from "./cart-totals.ts"
import { calculateCustomerShippingCost, calculateShippingBonus } from "../store-config.ts"
import type { SupabaseProducto } from "../supabase/types.ts"

const NO_SIGNALS: CommercialChangeSignals = {
  cartChanged: false,
  priceChanged: false,
  availabilityChanged: false,
  removedCount: 0,
  settingsChanged: false,
  shippingSettingsChanged: false,
  otherSettingsChanged: false,
}

const NO_SETTINGS_DIFF = { changed: false, shippingChanged: false, otherChanged: false }

const settings = {
  shipping: { freeShippingMode: "full", freeShippingMinAmount: 100_000, shippingBonusMax: 25_000 },
  installmentsFinancing: { enabled: true },
  pricing: { transferDiscountPercent: 10 },
  interestFreeOffer: { tiers: [{ count: 3 }], checkedAt: "2026-10-29T10:00:00Z" },
}

function makeProduct(overrides: Partial<SupabaseProducto> = {}): SupabaseProducto {
  return {
    id: 101,
    nombre: "Trípode Pro",
    precio: 46_000,
    precio_anterior: null,
    descuento: null,
    stock: 10,
    activo: true,
    producto_variantes: [],
    conditioned_stock: [],
    ...overrides,
  } as unknown as SupabaseProducto
}

function makeItem(product: SupabaseProducto): RefreshableCartItem {
  return {
    product,
    color: "default",
    quantity: 1,
    variantId: null,
    conditionedStockId: null,
    variantName: "Default",
    colorHex: null,
    unitPrice: product.precio,
    originalUnitPrice: null,
    discountReason: null,
  }
}

// A. Primera carga de configuración

test("A. la primera lectura de configuración es la base: nunca es un cambio", () => {
  assert.deepEqual(diffCommercialSettings(null, settings), NO_SETTINGS_DIFF)
  assert.deepEqual(diffCommercialSettings(undefined, settings), NO_SETTINGS_DIFF)
  assert.equal(getCommercialChangeCause(NO_SIGNALS), null)
})

test("A. una nueva sincronización de cuotas (sólo checkedAt) no es un cambio comercial", () => {
  const resynced = { ...settings, interestFreeOffer: { ...settings.interestFreeOffer, checkedAt: "2026-10-29T10:05:00Z" } }
  assert.deepEqual(diffCommercialSettings(settings, resynced), NO_SETTINGS_DIFF)
  assert.deepEqual(diffCommercialSettings(settings, { ...settings }), NO_SETTINGS_DIFF)
})

// B/C. Cotización de envío: normal, sin aviso, y sin cambiar las fórmulas

test("B. primera cotización Andreani: el cálculo real sigue igual ($129.500 + $17.860 = $147.360)", () => {
  const items = [{ product: { id: 1, precio: 129_500 }, quantity: 1, unitPrice: 129_500 }]
  const productsTotal = calculateCartTotals(items).productsTotal
  assert.equal(productsTotal, 129_500)
  assert.equal(calculateShippingBonus(productsTotal, 42_860, settings.shipping as never), 25_000)
  const shippingCost = calculateCustomerShippingCost(productsTotal, 42_860, settings.shipping as never)
  assert.equal(shippingCost, 17_860)
  assert.equal(calculateCartTotals(items, { shippingCost }).total, 147_360)
})

test("B/C. cotizar o recotizar por cambio de destino no genera señales de cambio comercial ni aviso", () => {
  // La cotización no pasa por el refresco comercial: sin señales no hay causa.
  assert.equal(getCommercialChangeCause(NO_SIGNALS), null)

  const checkout = readFileSync(new URL("../../app/checkout/page.tsx", import.meta.url), "utf8")
  const quoteEffectStart = checkout.indexOf("const handleQuoteFailure = ")
  const quoteEffectEnd = checkout.indexOf("}, [isDestinationQuotable, shippingQuotePayload])")
  assert.ok(quoteEffectStart > 0 && quoteEffectEnd > quoteEffectStart)
  assert.doesNotMatch(checkout.slice(quoteEffectStart, quoteEffectEnd), /setCommercialChange|setPricingConflict/)
  // Sólo lo activan el refresco comercial y el 409 (más el botón para cerrarlo).
  assert.equal(checkout.match(/setCommercialChange\(/g)?.length, 3)
  // 409, fin de la sincronización, reintento del saldo y "Entendido".
  assert.equal(checkout.match(/setPricingConflict\(/g)?.length, 4)
  assert.match(checkout, /onChange: \(result\) => setCommercialChange\(getDetectedCommercialChange\(result\)\)/)
})

// D. Carrito: precio con evidencia, prudente sin ella

test("D. cambio real de precio: la reconciliación lo identifica y el aviso habla de precio", () => {
  const result = reconcileCartWithCatalog([makeItem(makeProduct())], [makeProduct({ precio: 52_000 })])
  assert.equal(result.priceChanged, true)
  assert.equal(result.availabilityChanged, false)
  const cause = getCommercialChangeCause({ ...NO_SIGNALS, cartChanged: true, priceChanged: true })
  assert.equal(cause, "price")
  assert.equal(getCommercialUpdateNotice("price"), "Cambió el precio de uno o más productos. Revisá el nuevo total antes de pagar.")
})

test("D. carrito cambiado sin evidencia de precio ni stock: aviso prudente", () => {
  const cause = getCommercialChangeCause({ ...NO_SIGNALS, cartChanged: true })
  assert.equal(cause, "cart")
  assert.equal(getCommercialUpdateNotice("cart"), "Tu carrito cambió. Revisalo antes de continuar.")
})

// E. Disponibilidad

test("E. stock vendible cambiado: aviso de disponibilidad, no de precio", () => {
  const result = reconcileCartWithCatalog([makeItem(makeProduct())], [makeProduct({ stock: 0 })])
  assert.equal(result.availabilityChanged, true)
  assert.equal(result.priceChanged, false)
  const cause = getCommercialChangeCause({ ...NO_SIGNALS, cartChanged: true, availabilityChanged: true })
  assert.equal(getCommercialUpdateNotice(cause!), "Cambió la disponibilidad de uno o más productos. Revisá tu carrito.")
})

test("E. removedCount > 0: se aclara que el producto se quitó del carrito", () => {
  const result = reconcileCartWithCatalog([makeItem(makeProduct())], [])
  assert.equal(result.removed.length, 1)
  const cause = getCommercialChangeCause({ ...NO_SIGNALS, cartChanged: true, removedCount: 1 })
  assert.equal(cause, "removed")
  assert.equal(getCommercialUpdateNotice("removed", 1), "Un producto ya no está disponible y lo quitamos de tu carrito.")
  assert.equal(getCommercialUpdateNotice("removed", 2), "Algunos productos ya no están disponibles y los quitamos de tu carrito.")
})

// F. Configuración real cambiada después de tener una base

function settingsSignals(previous: typeof settings, next: typeof settings): CommercialChangeSignals {
  const diff = diffCommercialSettings(previous, next)
  return {
    ...NO_SIGNALS,
    settingsChanged: diff.changed,
    shippingSettingsChanged: diff.shippingChanged,
    otherSettingsChanged: diff.otherChanged,
  }
}

test("F. sólo cambia la configuración de envío: aviso de envío", () => {
  const next = { ...settings, shipping: { ...settings.shipping, shippingBonusMax: 20_000 } }
  assert.deepEqual(diffCommercialSettings(settings, next), { changed: true, shippingChanged: true, otherChanged: false })
  const cause = getCommercialChangeCause(settingsSignals(settings, next))
  assert.equal(cause, "shipping_settings")
  assert.equal(getCommercialUpdateNotice(cause!), "Se actualizó el costo de envío. Revisá el nuevo total antes de pagar.")
})

test("G. sólo cambia otra configuración comercial: aviso de condiciones", () => {
  const next = { ...settings, pricing: { transferDiscountPercent: 15 } }
  assert.deepEqual(diffCommercialSettings(settings, next), { changed: true, shippingChanged: false, otherChanged: true })
  const cause = getCommercialChangeCause(settingsSignals(settings, next))
  assert.equal(cause, "settings")
  assert.equal(
    getCommercialUpdateNotice(cause!),
    "Se actualizaron las condiciones de tu compra. Revisá el nuevo total antes de continuar.",
  )
})

test("H. envío + otra configuración a la vez: varias causas, no sólo envío", () => {
  const next = {
    ...settings,
    shipping: { ...settings.shipping, shippingBonusMax: 20_000 },
    interestFreeOffer: { tiers: [{ count: 6 }], checkedAt: settings.interestFreeOffer.checkedAt },
  }
  assert.deepEqual(diffCommercialSettings(settings, next), { changed: true, shippingChanged: true, otherChanged: true })
  const cause = getCommercialChangeCause(settingsSignals(settings, next))
  assert.equal(cause, "multiple")
  assert.equal(
    getCommercialUpdateNotice(cause!),
    "Tu compra cambió. Revisá los productos, el envío y el nuevo total antes de pagar.",
  )
})

// G. 409 PRICING_CHANGED

test("G. 409 PRICING_CHANGED sin causa conocida: no afirma que cambió un precio", () => {
  assert.equal(PRICING_CHANGED_UNKNOWN_NOTICE, "El total de tu compra cambió. Revisalo antes de pagar.")
  assert.equal(getPricingChangedNotice({ cause: null, newTotalLabel: null }), PRICING_CHANGED_UNKNOWN_NOTICE)
  assert.equal(
    getPricingChangedNotice({ cause: null, newTotalLabel: "$ 150.000" }),
    "El total de tu compra cambió. Nuevo total: $ 150.000. Revisalo antes de pagar.",
  )
  assert.doesNotMatch(getPricingChangedNotice({ cause: null, newTotalLabel: "$ 150.000" }), /precio/)
})

test("I. 409 con causa detectada por el refresco: aviso específico que conserva el nuevo total", () => {
  assert.equal(
    getPricingChangedNotice({ cause: "shipping_settings", newTotalLabel: "$ 147.360" }),
    "Se actualizó el costo de envío. Nuevo total: $ 147.360. Revisalo antes de pagar.",
  )
  assert.equal(
    getPricingChangedNotice({ cause: "price", newTotalLabel: "$ 150.000" }),
    "Cambió el precio de uno o más productos. Nuevo total: $ 150.000. Revisalo antes de pagar.",
  )
  assert.equal(
    getPricingChangedNotice({ cause: "multiple", newTotalLabel: "$ 147.360" }),
    "Tu compra cambió. Nuevo total: $ 147.360. Revisalo antes de pagar.",
  )
  assert.equal(
    getPricingChangedNotice({ cause: "removed", removedCount: 1, newTotalLabel: "$ 147.360" }),
    "Un producto ya no está disponible y lo quitamos de tu carrito. Nuevo total: $ 147.360. Revisalo antes de pagar.",
  )
})

// H. Varios cambios

test("H. varias causas a la vez: mensaje general", () => {
  const general = "Tu compra cambió. Revisá los productos, el envío y el nuevo total antes de pagar."
  for (const signals of [
    { ...NO_SIGNALS, cartChanged: true, priceChanged: true, availabilityChanged: true },
    { ...NO_SIGNALS, cartChanged: true, priceChanged: true, removedCount: 1 },
    { ...NO_SIGNALS, cartChanged: true, priceChanged: true, settingsChanged: true },
    { ...NO_SIGNALS, cartChanged: true, removedCount: 1, settingsChanged: true, shippingSettingsChanged: true },
    { ...NO_SIGNALS, settingsChanged: true, shippingSettingsChanged: true, otherSettingsChanged: true },
  ]) {
    const cause = getCommercialChangeCause(signals)
    assert.equal(cause, "multiple", JSON.stringify(signals))
    assert.equal(getCommercialUpdateNotice(cause!), general)
  }
})
