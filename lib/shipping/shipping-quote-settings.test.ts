import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  normalizeStoredShippingQuoteSettings,
  parseShippingQuoteSettingsPatch,
} from "./shipping-quote-settings.ts"
import { ShippingMarkupError } from "./shipping-pricing.ts"

test("Admin: el recargo acepta 0%, enteros y hasta 2 decimales", () => {
  for (const percent of [0, 2, 3, 5.5, 6, 12.25, 50]) {
    assert.deepEqual(parseShippingQuoteSettingsPatch({ logisticsMarkupPercent: percent }), { logisticsMarkupPercent: percent })
  }
})

test("Admin: el backend rechaza valores inválidos o campos extra (no confía en el navegador)", () => {
  for (const bad of [
    { logisticsMarkupPercent: -1 },
    { logisticsMarkupPercent: 50.5 },
    { logisticsMarkupPercent: 5.555 },
    { logisticsMarkupPercent: "5" },
    { logisticsMarkupPercent: Number.NaN },
    { logisticsMarkupPercent: Infinity },
    { logisticsMarkupPercent: 5, extra: true },
    {},
    null,
    [5],
  ]) {
    assert.throws(() => parseShippingQuoteSettingsPatch(bad), ShippingMarkupError)
  }
})

test("valor guardado ausente o corrupto equivale a 0% (comportamiento previo al recargo)", () => {
  assert.deepEqual(normalizeStoredShippingQuoteSettings(undefined), { logisticsMarkupPercent: 0 })
  assert.deepEqual(normalizeStoredShippingQuoteSettings({ logisticsMarkupPercent: "x" }), { logisticsMarkupPercent: 0 })
  assert.deepEqual(normalizeStoredShippingQuoteSettings({ logisticsMarkupPercent: 4 }), { logisticsMarkupPercent: 4 })
})

test("el recargo nunca viaja en la configuración pública ni a la respuesta del cotizador", () => {
  const publicSettings = readFileSync(new URL("../site-settings.ts", import.meta.url), "utf8")
  assert.doesNotMatch(publicSettings, /shipping_quote|logisticsMarkupPercent/)
  const quoteRoute = readFileSync(new URL("../../app/api/andreani/cotizar/route.ts", import.meta.url), "utf8")
  assert.doesNotMatch(quoteRoute, /\.\.\.option\b/)
  const settingsRoute = readFileSync(new URL("../../app/api/admin/settings/route.ts", import.meta.url), "utf8")
  assert.match(settingsRoute, /MANAGE_ROLES = \["admin", "super_admin"\]/)
  assert.match(settingsRoute, /parseShippingQuoteSettingsPatch\(shippingQuote\)/)
})
