import assert from "node:assert/strict"
import test from "node:test"

import {
  DEFAULT_ANDREANI_COMMERCIAL_SETTINGS,
  normalizeAndreaniCommercialSettings,
  normalizeSiteSettingsPatch,
} from "./site-settings.ts"

test("normalizeAndreaniCommercialSettings acepta enabled true/false explícito", () => {
  assert.deepEqual(normalizeAndreaniCommercialSettings({ enabled: true }), {
    enabled: true,
  })
  assert.deepEqual(normalizeAndreaniCommercialSettings({ enabled: false }), {
    enabled: false,
  })
})

test("PATCH de Andreani no escribe grupos ajenos aunque cambien concurrentemente", () => {
  const changes = normalizeSiteSettingsPatch({ andreaniCommercial: { enabled: false } })
  assert.deepEqual(changes, [{ key: "andreani_commercial", field: "andreaniCommercial", value: { enabled: false } }])
  const stored = new Map<string, unknown>([["stock", { criticalStockThreshold: 7 }]])
  stored.set("stock", { criticalStockThreshold: 12 })
  changes.forEach(({ key, value }) => stored.set(key, value))
  assert.deepEqual(stored.get("stock"), { criticalStockThreshold: 12 })
})

test("PATCH rechaza JSON inválido, mass assignment y valores comerciales ambiguos", () => {
  for (const value of [null, [], {}, { role: "admin" }, { andreaniCommercial: null },
    { andreaniCommercial: { enabled: "true" } }, { andreaniCommercial: { enabled: true, secret: "x" } }]) {
    assert.throws(() => normalizeSiteSettingsPatch(value))
  }
})

test("normalizeAndreaniCommercialSettings cae al default (inactivo) ante entradas inválidas", () => {
  for (const invalid of [null, undefined, {}, { enabled: "false" }, { enabled: 0 }, "false"]) {
    assert.deepEqual(
      normalizeAndreaniCommercialSettings(invalid),
      DEFAULT_ANDREANI_COMMERCIAL_SETTINGS,
    )
  }
})
