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
