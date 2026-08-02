import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const migration = readFileSync(
  new URL(
    "../../supabase/migrations/20260801102000_product_shipping_data.sql",
    import.meta.url,
  ),
  "utf8",
)

test("la migración agrega los cuatro campos a productos y variantes", () => {
  assert.match(migration, /alter table public\.productos[\s\S]*peso_empaquetado_kg/)
  assert.match(
    migration,
    /alter table public\.producto_variantes[\s\S]*largo_paquete_cm/,
  )
  assert.equal((migration.match(/add column if not exists/g) ?? []).length, 8)
})

test("la base rechaza NaN, cero, negativos y máximos excesivos", () => {
  assert.equal((migration.match(/<> 'NaN'::numeric/g) ?? []).length, 8)
  assert.equal((migration.match(/> 0/g) ?? []).length, 8)
  assert.match(migration, /peso_empaquetado_kg <= 10000/)
  assert.match(migration, /alto_paquete_cm <= 1000/)
  assert.match(migration, /ancho_paquete_cm <= 1000/)
  assert.match(migration, /largo_paquete_cm <= 1000/)
})

test("las RPC conservan las medidas en altas y ediciones atómicas", () => {
  assert.match(migration, /create_product_variant_with_allocation_v2/)
  assert.match(migration, /update_product_variant_with_allocation_v2/)
  assert.match(migration, /create or replace function public\.create_producto_completo_v2/)
})
