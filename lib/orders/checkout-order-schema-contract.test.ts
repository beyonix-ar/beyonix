import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const shippingReconciliationSql = readFileSync(
  new URL(
    "../../supabase/migrations/20260815130000_checkout_order_shipping_schema_reconciliation.sql",
    import.meta.url,
  ),
  "utf8",
)
const mercadoPagoIdempotencySql = readFileSync(
  new URL(
    "../../supabase/migrations/20260815120000_mercadopago_checkout_attempt_idempotency.sql",
    import.meta.url,
  ),
  "utf8",
)

test("las migraciones ejecutables cubren el contrato de envío de las órdenes", () => {
  const requiredColumns = [
    "cp_destino",
    "localidad",
    "provincia",
    "shipping_provider",
    "shipping_type",
    "shipping_cost_real",
    "shipping_cost_charged",
    "free_shipping_applied",
  ]

  for (const column of requiredColumns) {
    assert.match(
      shippingReconciliationSql,
      new RegExp(`add column if not exists ${column}\\b`),
      `Falta reconciliar public.ordenes.${column}`,
    )
  }

  assert.match(shippingReconciliationSql, /notify pgrst, 'reload schema'/)
})

test("la migración de Mercado Pago conserva RPC e índices idempotentes", () => {
  for (const index of [
    "ordenes_mercadopago_checkout_fingerprint_idx",
    "ordenes_mercadopago_request_rate_idx",
    "ordenes_mercadopago_expiration_idx",
  ]) {
    assert.match(
      mercadoPagoIdempotencySql,
      new RegExp(`create index if not exists ${index}\\b`),
      `Falta el índice ${index}`,
    )
  }

  assert.match(
    mercadoPagoIdempotencySql,
    /create or replace function public\.claim_mercadopago_order_preference\(/,
  )
  assert.match(
    mercadoPagoIdempotencySql,
    /grant execute on function public\.claim_mercadopago_order_preference\([\s\S]*?to service_role;/,
  )
})
