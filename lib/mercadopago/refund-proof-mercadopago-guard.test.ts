import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"

// FASE 1: para un pedido pagado por Mercado Pago, BEYONIX ya no puede
// cerrarse como 'refunded' subiendo un comprobante manual
// (commit_order_refund_proof) -- el refund real de MP
// (mercadopago_order_refunds / begin+record RPC) es la única vía. El flujo
// de comprobante debe seguir intacto para transferencia y demás medios.
//
// Se verifica por contrato de texto (mismo patrón que
// lib/customer-credit/rpc-authorization.test.ts): la definición nueva debe
// ser IDÉNTICA a la vigente (20260906100000) salvo el guard agregado al
// principio -- así se prueba que no se tocó ninguna otra regla (CAS de
// order_claim_operations, notas de crédito, comprobante, notificación).

const root = process.cwd()
const read = (path: string) => readFileSync(join(root, path), "utf8")
const originalMigration = read("supabase/migrations/20260906100000_claims_final_security.sql")
const newMigration = read("supabase/migrations/20260911190000_lock_manual_refund_proof_for_mercadopago.sql")

function extractFunctionBody(source: string, name: string) {
  const match = source.match(
    new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\nend \\$\\$;`),
  )
  if (!match) throw new Error(`No se encontró la función ${name}`)
  return match[0]
}

const originalFunction = extractFunctionBody(originalMigration, "commit_order_refund_proof")
const newFunction = extractFunctionBody(newMigration, "commit_order_refund_proof")

test("commit_order_refund_proof: la nueva definición es idéntica a la vigente salvo el guard de Mercado Pago", () => {
  const guardBlock = "  if v_order.payment_method_id = 'mercadopago' then\n    raise exception 'MERCADOPAGO_REQUIRES_REAL_REFUND';\n  end if;\n"
  assert.match(newFunction, /if v_order\.payment_method_id = 'mercadopago' then\s*\n\s*raise exception 'MERCADOPAGO_REQUIRES_REAL_REFUND';\s*\n\s*end if;/)

  const newWithoutGuard = newFunction.replace(guardBlock, "")
  assert.equal(
    newWithoutGuard,
    originalFunction,
    "el resto de la función (CAS de order_claim_operations, notas de crédito, comprobante, notificación) debe quedar byte a byte igual",
  )
})

test("el guard corta ANTES de tocar order_claim_operations/order_credit_notes -- nunca commitea nada para un pedido de Mercado Pago", () => {
  const guardIndex = newFunction.indexOf("MERCADOPAGO_REQUIRES_REAL_REFUND")
  const casCommittedIndex = newFunction.indexOf("if v_op.status='committed'")
  const creditNoteQueryIndex = newFunction.indexOf("from public.order_credit_notes")
  assert.ok(guardIndex > 0)
  assert.ok(guardIndex < casCommittedIndex, "el guard corre antes del CAS de la operación")
  assert.ok(guardIndex < creditNoteQueryIndex, "el guard corre antes de tocar order_credit_notes")
})

test("el guard es específico de 'mercadopago': transferencia y otros medios NO quedan bloqueados", () => {
  const guardCondition = newFunction.match(/if v_order\.payment_method_id = '([^']+)' then\s*\n\s*raise exception 'MERCADOPAGO_REQUIRES_REAL_REFUND'/)
  assert.ok(guardCondition)
  assert.equal(guardCondition![1], "mercadopago")
  assert.doesNotMatch(newFunction, /payment_method_id\s*(?:is distinct from|<>|!=)\s*'mercadopago'.*raise exception 'MERCADOPAGO_REQUIRES_REAL_REFUND'/)
})

test("permisos: commit_order_refund_proof sigue restringido a service_role, sin ampliar ni reducir grants", () => {
  assert.match(
    newMigration,
    /revoke all on function public\.commit_order_refund_proof\(uuid,uuid,jsonb\) from public,anon,authenticated;/,
  )
  assert.match(
    newMigration,
    /grant execute on function public\.commit_order_refund_proof\(uuid,uuid,jsonb\) to service_role;/,
  )
})
