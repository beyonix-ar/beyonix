import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

// Contrato de supabase/migrations/20260825090000_credit_note_requires_claim.sql:
// begin_partial_credit_note debe exigir un order_claims real para toda
// devolución iniciada por el cliente, salvo los tipos administrativos/
// contables (ajuste_manual, reembolso_excepcional), que preservan la vía
// sin reclamo. Ver app/api/admin/orders/[id]/credit-note/route.ts y
// lib/orders/credit-note-wizard.ts (operationRequiresClaim), que reflejan
// la misma regla del lado de la aplicación.
const migration = readFileSync(
  new URL(
    "../../supabase/migrations/20260825090000_credit_note_requires_claim.sql",
    import.meta.url,
  ),
  "utf8",
)
const hardeningMigration = readFileSync(
  new URL(
    "../../supabase/migrations/20260825120000_harden_credit_note_claim_policy.sql",
    import.meta.url,
  ),
  "utf8",
)
const cancellationMigration = readFileSync(
  new URL(
    "../../supabase/migrations/20260825130000_atomic_customer_cancellation_claim.sql",
    import.meta.url,
  ),
  "utf8",
)

test("hace drop explícito de la firma anterior de 11 parámetros antes de recrearla", () => {
  assert.match(
    migration,
    /drop function if exists public\.begin_partial_credit_note\(\s*bigint, bigint, text, text, numeric, numeric, numeric,\s*integer, bigint, uuid, jsonb\s*\);/,
  )
})

test("la nueva firma agrega p_operation_type y exige claim salvo ajuste_manual/reembolso_excepcional", () => {
  assert.match(migration, /p_operation_type text/)
  assert.match(
    migration,
    /coalesce\(p_operation_type, ''\) not in \('ajuste_manual', 'reembolso_excepcional'\)\s*\n\s*and p_claim_id is null then\s*\n\s*raise exception 'CLAIM_REQUIRED';/,
  )
})

test("conserva la validación de que un claim_id explícito pertenezca al pedido", () => {
  assert.match(
    migration,
    /if p_claim_id is not null and not exists \(\s*select 1\s*from public\.order_claims\s*where id = p_claim_id and order_id = p_order_id\s*\) then\s*raise exception 'INVALID_CREDIT_NOTE_CLAIM';/,
  )
})

test("no elimina tablas/índices/políticas ni otorga permisos de más", () => {
  assert.doesNotMatch(migration, /drop table/i)
  assert.doesNotMatch(migration, /drop index/i)
  assert.doesNotMatch(migration, /drop policy/i)
  assert.match(
    migration,
    /grant execute on function public\.begin_partial_credit_note\(\s*bigint, bigint, text, text, numeric, numeric, numeric,\s*integer, bigint, uuid, jsonb, text\s*\) to service_role;/,
  )
  assert.doesNotMatch(migration, /to (public|anon|authenticated);/)
})

test("la definición vigente valida actor, estado, cliente e items reclamados", () => {
  assert.match(hardeningMigration, /auth\.role\(\) <> 'service_role'/)
  assert.match(hardeningMigration, /v_actor_role not in \('admin', 'super_admin'\)/)
  assert.match(hardeningMigration, /v_claim\.user_id is distinct from v_order_user_id/)
  assert.match(hardeningMigration, /v_claim\.status not in \(/)
  assert.match(hardeningMigration, /v_claim\.failure_type = 'consulta_pedido'/)
  assert.match(hardeningMigration, /v_claim\.affected_items/)
  assert.match(hardeningMigration, /INVALID_CREDIT_NOTE_CLAIM_ITEM/)
})

test("la cancelación del cliente crea claim, cancela y audita en una sola RPC", () => {
  assert.match(cancellationMigration, /security definer[\s\S]*set search_path = public/)
  assert.match(cancellationMigration, /for update/)
  assert.match(cancellationMigration, /insert into public\.order_claims/)
  assert.match(cancellationMigration, /affected_items/)
  assert.match(cancellationMigration, /update public\.ordenes/)
  assert.match(cancellationMigration, /insert into public\.order_audit_events/)
  assert.match(cancellationMigration, /reverse_customer_credit_for_order/)
  assert.match(cancellationMigration, /to service_role/)
  assert.doesNotMatch(cancellationMigration, /to (public|anon|authenticated);/)
})

test("la vía administrativa no sirve como devolución sin claim", () => {
  assert.match(hardeningMigration, /v_actor_role <> 'super_admin'/)
  assert.match(hardeningMigration, /p_claim_id is not null/)
  assert.match(hardeningMigration, /jsonb_array_length[\s\S]*<> 0/)
  assert.match(hardeningMigration, /CREDIT_NOTE_ADMIN_ITEMS_FORBIDDEN/)
  assert.match(hardeningMigration, /operation_type[\s\S]*p_operation_type/)
})
