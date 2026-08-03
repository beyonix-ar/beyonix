import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), "utf8")
}

const purchases = source(
  "supabase/migrations/20260801093000_atomic_product_purchases.sql",
)
const returnsAndDeletes = source(
  "supabase/migrations/20260801091000_mercadolibre_returns_and_bulk_delete.sql",
)
const movementDates = source(
  "supabase/migrations/20260801092000_inventory_return_effective_dates.sql",
)
const reservations = source(
  "supabase/migrations/20260801095000_stock_reservations.sql",
)
const importSales = source(
  "supabase/migrations/20260801090000_idempotent_mercadolibre_import.sql",
)
const saleGuards = source(
  "supabase/migrations/20260801100000_inventory_sale_write_guards.sql",
)
const webReturns = source(
  "supabase/migrations/20260801101000_web_return_classification.sql",
)
const returnConditionFix = source(
  "supabase/migrations/20260801103000_fix_return_condition_validation.sql",
)
const singleSourceRepair = source(
  "supabase/migrations/20260801104000_inventory_single_source_and_repair.sql",
)
const primaryVariantMigration = source(
  "supabase/migrations/20260802120000_materialize_conditioned_primary_variants.sql",
)
const conditionedRoute = source(
  "app/api/admin/conditioned-stock/[id]/route.ts",
)

test("las compras simples y con variante ingresan por una única RPC atómica", () => {
  assert.match(purchases, /save_product_purchase_atomic\s*\(/i)
  assert.match(purchases, /variants\.producto_id\s*=\s*v_product_id/i)
  assert.match(purchases, /received_quantity,\s*reception_status/i)
  assert.match(purchases, /v_status = 'parcial'/i)
})

test("editar una compra bloquea el registro y los productos afectados", () => {
  assert.match(purchases, /where entries\.id = v_id\s+for update/i)
  assert.match(purchases, /unnest\(array\[v_previous\.product_id, v_product_id\]\)/i)
  assert.match(purchases, /pg_advisory_xact_lock\(93000/i)
})

test("eliminar o anular una compra no puede dejar stock negativo", () => {
  assert.match(purchases, /delete_product_purchase_atomic\s*\(/i)
  assert.match(purchases, /reception_status in \('pendiente', 'parcial', 'recibida', 'anulada'\)/i)
  assert.match(purchases, /no se puede eliminar una compra ya consumida/i)
})

test("las ventas web validan stock descontando reservas concurrentes", () => {
  assert.match(reservations, /validate_checkout_inventory_reservation\s*\(/i)
  assert.match(reservations, /v_stock, 0\) - v_reserved_other < v_item\.quantity/i)
  assert.match(reservations, /perform public\.decrement_checkout_inventory\(p_items\)/i)
})

test("las reservas son idempotentes por sesión, producto y variante", () => {
  assert.match(reservations, /unique nulls not distinct/i)
  assert.match(reservations, /where reservations\.session_id = p_session_id/i)
  assert.match(reservations, /expires_at <= now\(\)/i)
})

test("las devoluciones múltiples nunca superan las unidades vendidas", () => {
  assert.match(returnsAndDeletes, /p_received_quantity > v_sale\.quantity/i)
  assert.match(returnsAndDeletes, /pg_advisory_xact_lock/i)
  assert.match(returnsAndDeletes, /on conflict \(source_key\) do update/i)
  assert.match(returnsAndDeletes, /before_data,\s*after_data/i)
  assert.match(returnsAndDeletes, /reclasificación consumiría stock ya vendido/i)
})

test("la eliminación individual y total de ML comparten una transacción segura", () => {
  assert.match(returnsAndDeletes, /delete_mercadolibre_sales_atomic\s*\(/i)
  assert.match(returnsAndDeletes, /p_expected_count/i)
  assert.match(returnsAndDeletes, /delete from public\.mercadolibre_sales/i)
  assert.match(returnsAndDeletes, /insert into public\.audit_logs/i)
})

test("las fechas efectivas se separan de las fechas de registro", () => {
  assert.match(movementDates, /movements\.occurred_at at time zone/i)
  assert.match(movementDates, /movements\.created_at,\s+'approved_return'/i)
  assert.match(purchases, /purchase_date/i)
})

test("la importación ML serializa concurrencia y conserva la identidad estable", () => {
  assert.match(importSales, /pg_advisory_xact_lock/i)
  assert.match(importSales, /where sales\.source_key = v_source_key\s+for update/i)
  assert.match(importSales, /where id = v_existing\.id/i)
  assert.match(importSales, /md5\(/i)
  assert.doesNotMatch(importSales, /source_file_name[^\n]*\|/i)
})

test("los cambios atómicos de compras registran al usuario responsable", () => {
  assert.match(purchases, /set_config\('beyonix\.actor_id', p_actor_id::text, true\)/i)
  assert.match(purchases, /actor_user_id/i)
  assert.match(purchases, /before_data,\s*after_data/i)
})

test("las ventas manuales reciben identidad y revierten si exceden el stock", () => {
  assert.match(saleGuards, /prepare_manual_mercadolibre_sale_identity/i)
  assert.match(saleGuards, /pg_advisory_xact_lock\(93000/i)
  assert.match(saleGuards, /variants\.stock < 0/i)
  assert.match(saleGuards, /zz_reject_negative_(external|mercadolibre)_sale/i)
})

test("las devoluciones web conservan las cuatro clasificaciones físicas", () => {
  assert.match(webReturns, /new\.received_quantity > v_max_quantity/i)
  assert.match(webReturns, /new\.sellable_quantity \+ new\.discounted_quantity/i)
  assert.match(webReturns, /new\.conditioned_active := false/i)
  assert.match(webReturns, /new\.non_sellable_quantity/i)
})

test("las devoluciones con descuento no se mezclan con el stock normal", () => {
  assert.match(
    returnConditionFix,
    /new\.quantity\s*:=\s*new\.sellable_quantity\s*;/i,
  )
  assert.doesNotMatch(
    returnConditionFix,
    /new\.quantity\s*:=\s*new\.sellable_quantity\s*\+\s*new\.discounted_quantity/i,
  )
  assert.match(
    returnConditionFix,
    /sellable_quantity\s*\+\s*discounted_quantity\s*\+\s*non_sellable_quantity\s*\)\s*<=\s*received_quantity/i,
  )
  assert.match(returnConditionFix, /quantity\s*=\s*sellable_quantity/i)
})

test("mover una unidad a descuento conserva el total físico", () => {
  assert.match(singleSourceRepair, /'physicalDelta',\s*0/i)
  assert.match(singleSourceRepair, /'reclassification'/i)
  assert.match(singleSourceRepair, /discountedQuantity/i)
})

test("repetir una reclasificación usa la misma clave y no duplica", () => {
  assert.match(singleSourceRepair, /idempotency_key text not null unique/i)
  assert.match(singleSourceRepair, /where operations\.idempotency_key = v_key/i)
  assert.match(singleSourceRepair, /return v_return/i)
  assert.match(conditionedRoute, /conditioned-link:\$\{current\.id\}:\$\{sourceVariantId\}/i)
})

test("una devolución con descuento no pasa primero por normal", () => {
  assert.match(returnConditionFix, /new\.quantity\s*:=\s*new\.sellable_quantity/i)
  assert.doesNotMatch(
    returnConditionFix,
    /new\.quantity\s*:=\s*new\.sellable_quantity\s*\+\s*new\.discounted_quantity/i,
  )
})

test("reaperturas y ediciones establecen estado absoluto sin reaplicar deltas", () => {
  assert.match(returnsAndDeletes, /on conflict \(source_key\) do update set/i)
  assert.match(purchases, /where entries\.id = v_id\s+for update/i)
  assert.match(purchases, /set\s+product_id = v_product_id/i)
})

test("trigger y backend comparten una única proyección derivada", () => {
  assert.match(singleSourceRepair, /stock almacenado es una proyección de inventory_movements/i)
  assert.match(singleSourceRepair, /create or replace view public\.inventory_movements/i)
  assert.match(reservations, /perform public\.decrement_checkout_inventory\(p_items\)/i)
  assert.doesNotMatch(reservations, /update public\.(productos|producto_variantes)\s+set stock/i)
})

test("doble clic y reintento HTTP no crean otra compra ni otra orden", () => {
  assert.match(singleSourceRepair, /save_product_purchase_idempotent/i)
  assert.match(singleSourceRepair, /pg_advisory_xact_lock\(hashtext\('inventory-purchase'/i)
  assert.match(singleSourceRepair, /ordenes_checkout_idempotency_unique/i)
})

test("producto padre y variantes se comparan contra el mismo libro", () => {
  assert.match(singleSourceRepair, /inventory_variant_diagnostics/i)
  assert.match(singleSourceRepair, /inventory_stock_integrity integrity/i)
  assert.match(singleSourceRepair, /inventory_movements movements/i)
})

test("la variante principal real absorbe todas las fuentes sin inventar stock", () => {
  assert.match(primaryVariantMigration, /insert into public\.producto_variantes/i)
  assert.match(primaryVariantMigration, /'Principal'/i)
  assert.match(primaryVariantMigration, /update public\.product_cost_entries/i)
  assert.match(primaryVariantMigration, /update public\.mercadolibre_sales/i)
  assert.match(primaryVariantMigration, /update public\.inventory_return_movements/i)
  assert.match(primaryVariantMigration, /update public\.stock_reservations/i)
  assert.doesNotMatch(primaryVariantMigration, /insert into public\.inventory_operation_log/i)
})

test("la migración principal es idempotente y valida padre igual a suma de variantes", () => {
  assert.match(primaryVariantMigration, /where not exists[\s\S]*producto_variantes/i)
  assert.match(primaryVariantMigration, /pg_advisory_xact_lock\(93000/i)
  assert.match(primaryVariantMigration, /v_variants_after is distinct from v_parent_after/i)
  assert.match(primaryVariantMigration, /v_parent_after is distinct from v_stock_before/i)
  assert.match(primaryVariantMigration, /movements\.variant_id is null/i)
})

test("el diagnóstico señala el movimiento y la reparación sólo baja la asignación duplicada", () => {
  assert.match(singleSourceRepair, /possible_cause_movement_id/i)
  assert.match(singleSourceRepair, /duplicated_allocation/i)
  assert.match(singleSourceRepair, /quantity = quantity - v_diagnostic\.duplicated_allocation/i)
  assert.match(singleSourceRepair, /insert into public\.audit_logs/i)
  assert.doesNotMatch(singleSourceRepair, /delete from public\.inventory_return_movements/i)
})
