import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"

import { mapWithConcurrency } from "../async/map-with-concurrency.ts"
import { getProductPriceRange } from "../products/price-range.ts"

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), "utf8")
}

test("la concurrencia queda acotada y conserva la asociación de resultados", async () => {
  let active = 0
  let maximumActive = 0

  const results = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 3, async (item) => {
    active += 1
    maximumActive = Math.max(maximumActive, active)
    await new Promise((resolve) => setTimeout(resolve, 2))
    active -= 1
    return item * 10
  })

  assert.equal(maximumActive, 3)
  assert.deepEqual(results, [10, 20, 30, 40, 50, 60])
})

test("el catálogo server-first usa el rango real y evita recargar categorías", () => {
  const range = getProductPriceRange([
    { precio: 25_000 },
    { precio: 80_000 },
  ])
  assert.deepEqual(range, { min: 25_000, max: 80_000, step: 1_000 })

  const layout = source("components/products/products-page-layout.tsx")
  assert.match(layout, /useState\(initialPriceRange\.min\)/)
  assert.match(layout, /useState\(initialPriceRange\.max\)/)
  assert.match(
    layout,
    /initialCategories\.length\s*\? Promise\.resolve\(initialCategories\)\s*:\s*getStoreCategorias\(\)/,
  )
})

test("settings no conserva HTTP stale y las operaciones financieras leen fresco", () => {
  const publicRoute = source("app/api/store/settings/route.ts")
  const adminRoute = source("app/api/admin/settings/route.ts")
  const criticalRoutes = [
    "app/api/transferencia/create-order/route.ts",
    "app/api/customer-credit/create-order/route.ts",
    "app/api/customer-credit/mercadopago/preference/route.ts",
    "app/api/mercadopago/create-preference/route.ts",
  ]

  assert.match(publicRoute, /"Cache-Control": "no-store"/)
  assert.doesNotMatch(publicRoute, /stale-while-revalidate/)
  assert.match(adminRoute, /invalidateSiteSettingsCache\(\)/)
  for (const route of criticalRoutes) {
    assert.match(source(route), /getSiteSettings\(\{ fresh: true \}\)/)
  }
})

test("checkout muestra el shell sin habilitar acciones antes de estados críticos", () => {
  const checkout = source("app/checkout/page.tsx")

  assert.match(
    checkout,
    /areCriticalCheckoutStatesReady =\s*!isLoading &&\s*!customerCredit\.loading &&\s*!siteSettings\.loading/,
  )
  assert.match(
    checkout,
    /isFormValid = Boolean\(\s*areCriticalCheckoutStatesReady/,
  )
})

test("las APIs admin verifican JWT y rol actual antes de exponer datos", () => {
  const auth = source("lib/auth/admin-api.ts")
  const shell = source("app/admin/admin-client.tsx")

  assert.match(auth, /auth\.getClaims\(token\)/)
  assert.match(auth, /from\("profiles"\)/)
  assert.match(auth, /!isInternalRole\(role\)/)
  assert.match(shell, /hasResolvedInternalAccess && !routeDenied\s*\? children/)
  assert.match(shell, /useAdminNotifications\(hasResolvedInternalAccess\)/)
})

test("las RPC de clientes bloquean PII y agregan órdenes en una sola consulta", () => {
  const securityMigration = source(
    "supabase/migrations/20260817150000_secure_client_profiles_and_order_aggregates.sql",
  )
  const aggregateMigration = source(
    "supabase/migrations/20260817160000_optimize_client_order_summaries.sql",
  )

  assert.match(
    securityMigration,
    /revoke all on function public\.admin_get_client_profiles\(\) from public, anon, authenticated;/,
  )
  assert.match(securityMigration, /and public\.is_current_user_admin\(\)/)
  assert.match(aggregateMigration, /matched_orders as \(/)
  assert.match(aggregateMigration, /create index if not exists ordenes_usuario_id_idx/)
  assert.match(
    aggregateMigration,
    /create index if not exists ordenes_cliente_email_normalized_idx/,
  )
  assert.doesNotMatch(aggregateMigration, /join lateral/)
})
