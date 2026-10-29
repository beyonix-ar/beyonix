import assert from "node:assert/strict"
import test from "node:test"

import { refreshSiteSettings } from "../../hooks/use-site-settings"

// refreshSiteSettings con el fetch simulado: la primera lectura sólo fija la
// base (no hay aviso), una re-sincronización de cuotas tampoco, y un cambio
// comercial real contra una lectura anterior sí.

const baseSettings = {
  shipping: { freeShippingMode: "full", freeShippingMinAmount: 100_000, shippingBonusMax: 25_000, defaultShippingCost: 0, logisticsBaseSubsidy: 3_000 },
  pricing: { transferDiscountPercent: 10 },
  interestFreeOffer: { tiers: [{ count: 3, minAmount: 50_000 }], checkedAt: "2026-10-29T10:00:00Z" },
}

let nextResponse: unknown = { settings: baseSettings }
globalThis.fetch = (async () => Response.json(nextResponse)) as typeof fetch

test("primera carga de configuración: no es un cambio", async () => {
  const result = await refreshSiteSettings()
  assert.equal(result.changed, false)
  assert.equal(result.shippingChanged, false)
})

test("misma configuración con otro checkedAt de cuotas: no es un cambio", async () => {
  nextResponse = {
    settings: { ...baseSettings, interestFreeOffer: { ...baseSettings.interestFreeOffer, checkedAt: "2026-10-29T10:05:00Z" } },
  }
  const result = await refreshSiteSettings()
  assert.equal(result.changed, false)
})

test("cambio real del envío luego de una lectura válida: cambio de envío", async () => {
  nextResponse = { settings: { ...baseSettings, shipping: { ...baseSettings.shipping, shippingBonusMax: 20_000 } } }
  const result = await refreshSiteSettings()
  assert.equal(result.changed, true)
  assert.equal(result.shippingChanged, true)
  assert.equal(result.otherChanged, false)
})

test("otro cambio comercial: cambio de condiciones, no de envío", async () => {
  nextResponse = {
    settings: { ...baseSettings, shipping: { ...baseSettings.shipping, shippingBonusMax: 20_000 }, pricing: { transferDiscountPercent: 15 } },
  }
  const result = await refreshSiteSettings()
  assert.equal(result.changed, true)
  assert.equal(result.shippingChanged, false)
  assert.equal(result.otherChanged, true)
})

test("envío + otra configuración en la misma lectura: se informan ambos cambios", async () => {
  nextResponse = {
    settings: {
      ...baseSettings,
      shipping: { ...baseSettings.shipping, shippingBonusMax: 18_000 },
      pricing: { transferDiscountPercent: 12 },
    },
  }
  const result = await refreshSiteSettings()
  assert.equal(result.changed, true)
  assert.equal(result.shippingChanged, true)
  assert.equal(result.otherChanged, true)
})
