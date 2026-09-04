import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

/**
 * `public.validate_inventory_order_confirmation()` (definida en
 * 20260730174000_sellable_conditioned_variants.sql) es el ÚNICO guardián que
 * impide confirmar una orden como pagada cuando el stock derivado real ya no
 * alcanza para sus ítems. Esa migración sólo reemplaza el CUERPO de la
 * función -- nunca crea el TRIGGER que la conecta a `ordenes`. El único
 * lugar que sí lo hacía era `supabase/sql/093_unified_inventory_source.sql`,
 * el archivo histórico/manual que NO es la fuente de verdad de lo aplicado.
 *
 * Sin el trigger realmente adjunto en las migraciones aplicadas, el webhook
 * de Mercado Pago y la aprobación manual de transferencias pueden confirmar
 * un pago sobre stock inexistente sin que nada lo impida -- exactamente lo
 * que approved_stock_conflict (order-payment.ts) asume que SÍ está pasando.
 */

const GUARD_FUNCTION_MIGRATION = readFileSync(
  "supabase/migrations/20260730174000_sellable_conditioned_variants.sql",
  "utf8",
)
const TRIGGER_ATTACHMENT_MIGRATION = readFileSync(
  "supabase/migrations/20260904090000_attach_inventory_order_confirmation_guard.sql",
  "utf8",
)

test("la función guardián está definida (soporta conditioned_stock_id)", () => {
  assert.match(
    GUARD_FUNCTION_MIGRATION,
    /create or replace function public\.validate_inventory_order_confirmation\(\)/,
  )
  assert.match(GUARD_FUNCTION_MIGRATION, /items\.conditioned_stock_id/)
  assert.match(GUARD_FUNCTION_MIGRATION, /raise exception 'CHECKOUT_STOCK_INSUFFICIENT'/)
})

test("ninguna migración aplicada crea el trigger salvo la nueva -- por eso hacía falta", () => {
  const migrationsDefiningTrigger = [
    "supabase/migrations/20260730174000_sellable_conditioned_variants.sql",
    "supabase/migrations/20260801095000_stock_reservations.sql",
    "supabase/migrations/20260801104000_inventory_single_source_and_repair.sql",
  ].map((path) => readFileSync(path, "utf8"))

  for (const migration of migrationsDefiningTrigger) {
    assert.doesNotMatch(
      migration,
      /create trigger validate_inventory_order_confirmation/,
    )
  }
})

test("la nueva migración adjunta el trigger de forma idempotente (drop + create)", () => {
  assert.match(
    TRIGGER_ATTACHMENT_MIGRATION,
    /drop trigger if exists validate_inventory_order_confirmation on public\.ordenes;/,
  )
  assert.match(
    TRIGGER_ATTACHMENT_MIGRATION,
    /create trigger validate_inventory_order_confirmation\s*\nbefore update of estado, payment_status on public\.ordenes\s*\nfor each row execute function public\.validate_inventory_order_confirmation\(\);/,
  )
})

test("el trigger corre BEFORE (puede abortar la transición) y sólo en estado/payment_status", () => {
  assert.match(TRIGGER_ATTACHMENT_MIGRATION, /^before update of estado, payment_status/m)
  assert.doesNotMatch(TRIGGER_ATTACHMENT_MIGRATION, /after update/i)
})

const PAYMENT_STATUS_ROUTE = readFileSync(
  "app/api/admin/pedidos/[id]/payment-status/route.ts",
  "utf8",
)

test("la aprobación manual de transferencia falla cerrado y con mensaje claro ante conflicto de stock", () => {
  assert.match(PAYMENT_STATUS_ROUTE, /checkout_stock_insufficient/i)
  assert.match(PAYMENT_STATUS_ROUTE, /status: 409/)
  assert.match(PAYMENT_STATUS_ROUTE, /payment_confirmation_blocked_stock_conflict/)
  // El código técnico crudo del trigger nunca llega tal cual al admin.
  assert.doesNotMatch(
    PAYMENT_STATUS_ROUTE,
    /error: error\?\.message \|\| "No se pudo actualizar el estado de pago\."\s*\},\s*\{\s*status: 409/,
  )
})
