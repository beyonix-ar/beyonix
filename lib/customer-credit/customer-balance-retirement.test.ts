import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"

const root = process.cwd()

function read(relativePath: string) {
  return readFileSync(join(root, relativePath), "utf8")
}

test("los créditos y débitos administrativos conservan el libro de saldo", () => {
  const route = read("app/api/admin/customer-credit/route.ts")
  const balanceSql = read("supabase/sql/057_customer_credit_balance.sql")

  assert.match(route, /value === "credit"/)
  assert.match(route, /value === "debit"/)
  assert.match(route, /createCustomerCreditMovement/)
  assert.match(route, /source_kind: "balance_adjustment"/)
  assert.match(
    balanceSql,
    /when p_movement_type in \('credit', 'reversal', 'adjustment'\) then 1/,
  )
  assert.match(
    balanceSql,
    /when p_movement_type in \('debit', 'expiration'\) then -1/,
  )
})

test("la transferencia validada conserva la acreditación atómica", () => {
  const route = read("app/api/admin/clientes/saldos/route.ts")

  assert.match(route, /resolve_customer_credit_topup/)
  assert.match(route, /p_action: action/)
  assert.match(route, /p_amount: amount/)
  assert.match(route, /resulting_balance/)
})

test("la nota de crédito continúa acreditando saldo con idempotencia", () => {
  const server = read("lib/customer-credit/server.ts")

  assert.match(server, /creditCustomerForOrderCreditNote/)
  assert.match(server, /movementType: "credit"/)
  assert.match(server, /sourceType: "credit_note"/)
  assert.match(server, /sourceKey: getCreditNoteSourceKey/)
})

test("checkout conserva saldo de cuenta y no ofrece canje de tarjetas regalo", () => {
  const checkout = read("app/checkout/page.tsx")

  assert.match(checkout, /useCustomerCredit/)
  assert.match(checkout, /Saldo a favor/)
  assert.doesNotMatch(checkout, /GiftCard|Gift Card|gift-card|gift_card/)
})

test("sidebar y rutas retiradas no exponen el sistema discontinuado", () => {
  const sidebar = read("app/admin/admin-client.tsx")
  const routes = read("lib/admin/admin-routes.ts")
  const retiredPaths = [
    "app/admin/giftcard/page.tsx",
    "app/gift-card/[token]/page.tsx",
    "app/api/admin/customer-credit/giftcards/route.ts",
    "app/api/customer-credit/gift-card/route.ts",
    "app/api/gift-cards/[token]/route.ts",
    "app/api/gift-cards/redeem-code/route.ts",
  ]

  assert.doesNotMatch(sidebar, /GiftCard|Gift Card|giftcard/)
  assert.doesNotMatch(routes, /giftcard|gift-card/)
  for (const path of retiredPaths) assert.equal(existsSync(join(root, path)), false)
})

test("Productos muestra una alerta comprensible para variantes pendientes", () => {
  const toolbar = read("app/admin/sections/productos/productos-toolbar.tsx")

  assert.match(toolbar, /TriangleAlert/)
  assert.match(toolbar, /productos con variantes pendientes/)
  assert.doesNotMatch(toolbar, /rounded-full border border-red-200/)
})

test("la migración retira ejecución sin borrar datos históricos", () => {
  const migration = read(
    "supabase/migrations/20260808230000_retire_gift_card_runtime.sql",
  )

  assert.match(migration, /drop function if exists public\.claim_customer_gift_card/)
  assert.match(migration, /revoke all on table public\.customer_gift_cards/)
  assert.match(migration, /benefit_type = 'discount'/)
  assert.doesNotMatch(migration, /delete\s+from/i)
  assert.doesNotMatch(migration, /^\s*drop\s+table/im)
  assert.doesNotMatch(migration, /customer_credit_movements\s*(?:;|cascade)/i)
})
