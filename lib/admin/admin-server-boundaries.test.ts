import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), "utf8")
}

test("las alertas de integridad no consultan vistas restringidas desde el navegador", () => {
  const client = source("lib/admin/admin-notifications.ts")
  const route = source("app/api/admin/inventory/notification-diagnostics/route.ts")

  assert.doesNotMatch(client, /\.from\("inventory_stock_integrity"\)/)
  assert.doesNotMatch(client, /\.from\("inventory_variant_diagnostics"\)/)
  assert.match(client, /fetch\("\/api\/admin\/inventory\/notification-diagnostics"/)
  assert.match(route, /requireInternalUser\(request, \["admin", "super_admin"\]\)/)
  assert.match(route, /auth\.admin/)
})

test("las vistas de eventos del admin se leen y escriben por una API autenticada", () => {
  const client = source("lib/admin/order-event-views.ts")
  const route = source("app/api/admin/order-event-views/route.ts")

  assert.doesNotMatch(client, /\.from\("admin_order_event_views"\)/)
  assert.match(client, /fetch\(`\/api\/admin\/order-event-views\?/)
  assert.match(client, /fetch\("\/api\/admin\/order-event-views"/)
  assert.match(route, /requireInternalUser\(request, \["admin", "super_admin"\]\)/)
  assert.match(route, /\.eq\("admin_id", auth\.user\.id\)/)
  assert.match(route, /admin_id: auth\.user\.id/)
})

test("admin_order_event_views existe con RLS y sin permisos de browser", () => {
  const migration = source(
    "supabase/migrations/20260826120000_create_admin_order_event_views.sql",
  )

  assert.match(migration, /create table if not exists public\.admin_order_event_views/)
  assert.match(migration, /primary key \(admin_id, order_id, event_type\)/)
  assert.match(migration, /enable row level security/)
  assert.match(
    migration,
    /revoke all on table public\.admin_order_event_views from public, anon, authenticated/,
  )
  assert.match(migration, /grant select, insert, update, delete[^;]+service_role/)
})

test("CASO G (precio único): en modo manual, el precio que manda el navegador se persiste tal cual -- Admin nunca lo recalcula automáticamente", () => {
  const route = source("app/api/admin/products/[id]/catalog/route.ts")

  // El bloque que sobreescribe catalogInput.precio SÓLO corre dentro del
  // `if (pricingMode === "target_margin")`; en manual, catalogInput.precio
  // nunca se toca -- pasa intacto a la RPC con el valor que mandó el admin.
  const targetMarginBlockStart = route.indexOf('if (pricingMode === "target_margin")')
  const priceOverwriteIndex = route.indexOf("catalogInput.precio = targetMarginResult.commercialPrice")
  const rpcCallIndex = route.indexOf("update_product_commercial_configuration_atomic")

  assert.ok(targetMarginBlockStart >= 0)
  assert.ok(priceOverwriteIndex > targetMarginBlockStart)
  assert.ok(priceOverwriteIndex < rpcCallIndex)
  // Ningún otro lugar del archivo toca catalogInput.precio.
  assert.equal(
    (route.match(/catalogInput\.precio\s*=/g) ?? []).length,
    1,
  )
})

test("precio objetivo (margen): siempre recalculado server-side con la modalidad de cuotas HABILITADA real del catálogo, nunca confía en el precio del navegador", () => {
  const route = source("app/api/admin/products/[id]/catalog/route.ts")

  assert.match(route, /calculateTargetMarginPrice\(/)
  assert.match(route, /eligibleInstallmentCounts,\s*\n\s*config: installmentsFinancing,/)
  assert.match(
    route,
    /Autoritativo: el precio que haya mandado el navegador se ignora/,
  )
})
