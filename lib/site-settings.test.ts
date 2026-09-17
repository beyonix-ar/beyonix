import assert from "node:assert/strict"
import test from "node:test"

import {
  DEFAULT_ANDREANI_COMMERCIAL_SETTINGS,
  getSiteSettings,
  invalidateSiteSettingsCache,
  normalizeAndreaniCommercialSettings,
  normalizeSiteSettingsPatch,
  SiteSettingsUnavailableError,
} from "./site-settings.ts"

/**
 * Simula una falla de lectura de site_settings (red, RLS, lo que sea) sin
 * red real: createAdminClient() (lib/supabase/admin.ts) lanza sin
 * NEXT_PUBLIC_SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY configuradas, que es
 * exactamente el mismo camino de error que loadSiteSettings ya captura.
 */
async function withBrokenSupabaseAdminEnv<T>(run: () => Promise<T>): Promise<T> {
  const savedUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const savedKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  delete process.env.NEXT_PUBLIC_SUPABASE_URL
  delete process.env.SUPABASE_SERVICE_ROLE_KEY
  invalidateSiteSettingsCache()

  try {
    return await run()
  } finally {
    if (savedUrl !== undefined) process.env.NEXT_PUBLIC_SUPABASE_URL = savedUrl
    if (savedKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = savedKey
    invalidateSiteSettingsCache()
  }
}

test("BLOQUEANTE 1: getSiteSettings({fresh:true}) (operaciones financieras) falla cerrado -- nunca cae a defaults en silencio", async () => {
  await withBrokenSupabaseAdminEnv(async () => {
    await assert.rejects(
      getSiteSettings({ fresh: true }),
      SiteSettingsUnavailableError,
    )
  })
})

test("la lectura cacheada (páginas no financieras) conserva el fallback a defaults, no rompe el sitio por un hiccup transitorio", async () => {
  await withBrokenSupabaseAdminEnv(async () => {
    const settings = await getSiteSettings()
    assert.deepEqual(settings.andreaniCommercial, DEFAULT_ANDREANI_COMMERCIAL_SETTINGS)
  })
})

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
