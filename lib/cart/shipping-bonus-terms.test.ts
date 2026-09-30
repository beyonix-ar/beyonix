import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test, { mock } from "node:test"

import { formatWholeARS, getShippingTermsCopy } from "@/lib/legal/shipping-terms"
import { getSiteSettings, invalidateSiteSettingsCache } from "@/lib/site-settings"

// F/G. Términos y condiciones informa el tope de bonificación de envío desde
// la MISMA configuración que edita el Admin y que usa la cotización real
// (site_settings.shipping.shippingBonusMax), y refleja cualquier cambio.

const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n")

test("F. la página de Términos arma el copy de envío con getShippingTermsCopy(siteSettings.shipping)", () => {
  const page = read("app/terminos/page.tsx")
  assert.match(page, /const siteSettings = await getSiteSettings\(\)/)
  assert.match(page, /const shippingTerms = getShippingTermsCopy\(siteSettings\.shipping\)/)
  assert.match(page, /value=\{shippingTerms\.keyFactValue\}\s*detail=\{shippingTerms\.keyFactDetail\}/)
  assert.match(page, /\{shippingTerms\.bonusNotice\}/)
  // Sin montos ni constantes paralelas en la página.
  assert.doesNotMatch(page, /SHIPPING_BONUS_MAX|shippingBonusMax|20[._]?000/)
  // La cotización real usa la misma configuración.
  assert.match(read("lib/andreani/checkout-quote.ts"), /\(await getSiteSettings\(\{ fresh: true \}\)\)\.shipping/)
})

test("G. cambiar el tope en Admin (site_settings) cambia el texto de Términos: 20.000 → 15.000 → 30.000", async () => {
  const previousEnv = { url: process.env.NEXT_PUBLIC_SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY }
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://terms-test.invalid"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service"
  let shippingBonusMax = 20_000
  let reads = 0
  const fetchMock = mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = new URL(String(input))
    assert.equal(url.pathname, "/rest/v1/site_settings")
    reads += 1
    return Response.json([{
      key: "shipping",
      value: { defaultShippingCost: 0, freeShippingMinAmount: 75_000, shippingBonusMax, freeShippingMode: "full", logisticsBaseSubsidy: 3_000 },
    }])
  })
  try {
    for (const nextMax of [20_000, 15_000, 30_000]) {
      shippingBonusMax = nextMax
      // Lo mismo que hace /api/admin/settings al guardar.
      invalidateSiteSettingsCache()
      // Misma lectura que la página (cacheada, sin fresh).
      const copy = getShippingTermsCopy((await getSiteSettings()).shipping)
      assert.equal(copy.keyFactDetail, `Bonificación de hasta ${formatWholeARS(nextMax)}.`)
      assert.ok(copy.bonusNotice?.includes(`bonifica hasta ${formatWholeARS(nextMax)} del costo logístico`))
      assert.equal(copy.keyFactValue, `Desde ${formatWholeARS(75_000)}`)
    }
    assert.equal(reads, 3, "cada cambio se volvió a leer de site_settings")
  } finally {
    fetchMock.mock.restore()
    invalidateSiteSettingsCache()
    if (previousEnv.url === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL; else process.env.NEXT_PUBLIC_SUPABASE_URL = previousEnv.url
    if (previousEnv.key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = previousEnv.key
  }
})

test("sin bonificación activa, Términos no informa tope", () => {
  const copy = getShippingTermsCopy({ defaultShippingCost: 0, freeShippingMinAmount: 75_000, shippingBonusMax: 20_000, freeShippingMode: "off", logisticsBaseSubsidy: 0 })
  assert.equal(copy.bonusNotice, null)
  assert.doesNotMatch(`${copy.keyFactValue} ${copy.keyFactDetail}`, /\$/)
})
