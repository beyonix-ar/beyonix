import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), "utf8")
}

const manualAdjustment = source(
  "supabase/migrations/20260820180000_manual_stock_adjustment.sql",
)
const forceDeleteKnowsAdjustments = source(
  "supabase/migrations/20260820190000_force_delete_knows_stock_adjustments.sql",
)
const forceDeleteDisablesRelink = source(
  "supabase/migrations/20260820200000_force_delete_disables_catalog_relink_trigger.sql",
)
const activationUsesRealStock = source(
  "supabase/migrations/20260820170000_variant_activation_uses_real_stock.sql",
)
const purchaseRequiresVariant = source(
  "supabase/migrations/20260821090000_purchase_requires_variant_when_product_has_variants.sql",
)

// Caso A/B/C — una compra tagueada directamente a variant_id ya deja el
// stock físico correcto sin un paso de asignación posterior; el bug real
// era que product_variant_activation_error() sólo miraba
// inventory_variant_allocations en lugar del stock real de la variante.
test("la activación de variante usa el stock real, no la tabla de asignación manual", () => {
  assert.match(
    activationUsesRealStock,
    /coalesce\(v_variant\.stock,\s*0\)\s*<=\s*0/i,
  )
  const functionBody = activationUsesRealStock.slice(
    activationUsesRealStock.indexOf("create or replace function"),
  )
  assert.doesNotMatch(functionBody, /inventory_variant_allocations/i)
})

// Caso: un producto con variantes ya no puede comprarse "a nivel producto"
// (variant_id null) — ese era el camino que dejaba unidades como stock
// agregado del producto sin acreditar ninguna variante específica.
test("una compra nueva sobre un producto con variantes exige variant_id", () => {
  assert.match(
    purchaseRequiresVariant,
    /v_id is null\s+and v_variant_id is null\s+and v_product_id is not null/i,
  )
  assert.match(
    purchaseRequiresVariant,
    /elegí el color\/sku específico/i,
  )
})

// Caso H/I/J — el ajuste manual es una cantidad ABSOLUTA no negativa
// (nunca un delta libre), así que un stock negativo es estructuralmente
// imposible sin necesidad de un chequeo adicional post-cálculo.
test("el ajuste manual de stock no admite una cantidad nueva negativa", () => {
  assert.match(
    manualAdjustment,
    /p_new_quantity is null or p_new_quantity < 0/i,
  )
  assert.match(manualAdjustment, /quantity_delta integer not null check \(quantity_delta <> 0\)/i)
})

test("el ajuste manual exige un motivo y queda registrado como movimiento propio", () => {
  assert.match(manualAdjustment, /reason text not null check/i)
  assert.match(manualAdjustment, /v_reason is null or length\(v_reason\) < 3/i)
  assert.match(
    manualAdjustment,
    /'adjustment'::text,\s*\n\s*'inventory_stock_adjustments'::text/i,
  )
})

test("el ajuste manual es idempotente por clave, igual que compras y gastos", () => {
  assert.match(
    manualAdjustment,
    /select 1 from public\.inventory_operation_log log\s+where log\.idempotency_key = v_key/i,
  )
})

// El borrado forzado (super admin) debía conocer la tabla nueva de ajustes
// manuales y el trigger de auto-vinculación de compras; si no, la variante
// nunca terminaba de desacoplarse y el borrado fallaba en un loop.
test("el borrado forzado también purga los ajustes manuales de stock", () => {
  assert.match(
    forceDeleteKnowsAdjustments,
    /delete from public\.inventory_stock_adjustments\s+where variant_id = p_variant_id/i,
  )
  assert.match(
    forceDeleteKnowsAdjustments,
    /delete from public\.inventory_stock_adjustments\s+where product_id = p_product_id/i,
  )
})

test("el borrado forzado deshabilita el trigger que re-vincula compras al desacoplar", () => {
  assert.match(
    forceDeleteDisablesRelink,
    /disable trigger link_cost_entry_to_shared_catalog/i,
  )
  assert.match(
    forceDeleteDisablesRelink,
    /enable trigger link_cost_entry_to_shared_catalog/i,
  )
})
