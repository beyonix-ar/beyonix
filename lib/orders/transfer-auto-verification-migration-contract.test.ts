import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const migration = readFileSync(
  "supabase/migrations/20260913120000_transfer_auto_verification.sql",
  "utf8",
)

test("un mismo payment.id de Mercado Pago nunca puede acreditar dos pedidos (índice único parcial)", () => {
  assert.match(
    migration,
    /create unique index if not exists ordenes_transfer_matched_payment_id_key\s*\n\s*on public\.ordenes \(transfer_matched_payment_id\)\s*\n\s*where transfer_matched_payment_id is not null;/,
  )
})

test("confirm_transfer_auto_verification revalida la unicidad DENTRO de la transacción, no sólo confía en el índice", () => {
  assert.match(migration, /TRANSFER_PAYMENT_ID_ALREADY_USED/)
  assert.match(migration, /when unique_violation then/)
})

test("ambas funciones son security definer restringidas a service_role (nunca anon/authenticated)", () => {
  for (const fn of [
    "claim_transfer_verification_attempt",
    "confirm_transfer_auto_verification",
  ]) {
    const revokeMatch = migration.match(
      new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\)\\s*\\n\\s*from public, anon, authenticated;`),
    )
    const grantMatch = migration.match(
      new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\)\\s*\\n\\s*to service_role;`),
    )
    assert.ok(revokeMatch, `falta revoke para ${fn}`)
    assert.ok(grantMatch, `falta grant a service_role para ${fn}`)
  }
})

test("ambas funciones exigen auth.role() = service_role explícitamente (fail-closed dentro de la función)", () => {
  const occurrences = migration.match(/auth\.role\(\) <> 'service_role'/g) ?? []
  assert.ok(occurrences.length >= 2, "cada función debe validar service_role")
})

test("claim_transfer_verification_attempt sólo reclama pedidos pendiente_comprobante/en_revision, nunca ya confirmados/rechazados (incluso si payment_status fuera NULL)", () => {
  assert.match(
    migration,
    /if coalesce\(v_order\.payment_status, ''\) not in \('pendiente_comprobante', 'en_revision'\) then\s*\n\s*raise exception 'ALREADY_RESOLVED/,
  )
})

test("confirm_transfer_auto_verification reutiliza el mismo esquema de campos 'confirmado' que la aprobación manual (no duplica el significado de esos campos)", () => {
  assert.match(migration, /payment_status = 'confirmado'/)
  assert.match(migration, /estado = 'pagado'/)
  assert.match(migration, /financial_status = 'payment_confirmed'/)
  assert.match(migration, /order_change_status = 'change_approved'/)
})

test("ambas funciones fijan search_path con el mismo esquema endurecido que las RPC financieras ya auditadas (pg_catalog, public, pg_temp)", () => {
  const occurrences = migration.match(
    /set search_path to 'pg_catalog', 'public', 'pg_temp'/g,
  ) ?? []
  assert.equal(occurrences.length, 2, "las dos funciones deben fijar el mismo search_path endurecido")
  // No debe quedar ningún rastro del patrón anterior, más débil (set search_path = public).
  assert.doesNotMatch(migration, /set search_path = public\b/)
})

test("la migración es aditiva: sólo agrega columnas nullable/con default, nunca DROP ni ALTER destructivo", () => {
  assert.doesNotMatch(migration, /drop column/i)
  assert.doesNotMatch(migration, /drop table/i)
  assert.doesNotMatch(migration, /alter column[\s\S]*type/i)
  assert.match(migration, /add column if not exists/i)
})
