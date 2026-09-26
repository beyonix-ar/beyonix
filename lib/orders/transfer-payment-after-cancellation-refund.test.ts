import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

import { getAdminPendingOrderActions } from "./admin-pending-actions.ts"
import { getCancellationPanelViewModel } from "./cancellation-panel-view.ts"

// approved_after_cancellation -> resolución con el flujo de reintegro que YA
// existe (commit_order_refund_proof, rama sin nota de crédito). RPCs SQL
// reales sobre PostgreSQL en memoria: registro de la transferencia tardía
// (20260926120000) + reintegro (20260917130000), mismo fixture que
// lib/mercadopago/refund-without-credit-note.test.ts.

const root = process.cwd()
const read = (path: string) => readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n")
const admin = "10000000-0000-4000-8000-000000000003"
const customer = "10000000-0000-4000-8000-000000000001"

async function setup() {
  const db = new PGlite()
  await db.exec(read("lib/mercadopago/fixtures/refund-without-credit-note.sql"))
  await db.exec(read("supabase/migrations/20260917130000_external_refund_without_credit_note_and_mp_nc_policy.sql"))
  await db.exec(`
    alter table public.ordenes
      add column payment_status text,
      add column cancelled_at timestamptz,
      add column refund_pending_at timestamptz,
      add column store_benefit_id text,
      add column transfer_verification_status text default 'pending',
      add column transfer_verification_failure_reason text,
      add column transfer_last_verification_at timestamptz,
      add column transfer_matched_payment_id text unique,
      add column transfer_match_snapshot jsonb,
      add column transfer_amount_declared numeric;
    create table public.transfer_verification_payment_claims (
      payment_id text primary key,
      order_id bigint not null references public.ordenes(id),
      claimed_at timestamptz not null default now()
    );
  `)
  await db.exec(read("supabase/migrations/20260926120000_transfer_payment_after_cancellation.sql"))
  await db.query("select set_config('request.jwt.claim.role','service_role',false)")
  await db.query("insert into auth.users(id) values($1),($2)", [admin, customer])
  await db.query("insert into public.profiles(id,rol) values($1,'admin'),($2,'cliente')", [admin, customer])
  // Pedido A: se canceló sin pago al iniciar un nuevo intento. El saldo
  // (200) y el beneficio ya se devolvieron: external_amount_due volvió al
  // total (900), pero al cliente se le indicó transferir 700.
  await db.query(`insert into ordenes (id, usuario_id, total, external_amount_due, credit_balance_used, payment_method_id,
      financial_status, estado, payment_status, credit_note_required, transfer_amount_declared, store_benefit_id, cancelled_at)
    values (1, $1, 900, 900, 0, 'transferencia', 'cancelled', 'cancelado', 'checkout_superseded', false, 700, 'benefit-1', now())`, [customer])
  return db
}

const record = (db: PGlite, paymentId = "pay-late-1", amount = 700) => db.query<Record<string, unknown>>(
  `select * from record_transfer_payment_after_cancellation(1,$1,'money_transfer','account_money',$2,'CUIL','20301112220','30111222',null,now(),now())`,
  [paymentId, amount],
)

async function refund(db: PGlite, path: string, operationId = randomUUID()) {
  await db.query(
    `insert into order_claim_operations (id, actor_id, order_id, request_key, status, file_paths, bucket_id)
     values ($1, $2, 1, $3, 'uploading', $4, 'payment-proofs') on conflict (id) do nothing`,
    [operationId, admin, randomUUID(), [path]],
  )
  await db.query(`insert into storage.objects (bucket_id, name) values ('payment-proofs', $1) on conflict do nothing`, [path])
  return db.query<Record<string, unknown>>("select * from commit_order_refund_proof($1, $2, $3::jsonb)", [
    operationId,
    admin,
    JSON.stringify({ path, name: "reintegro.pdf", type: "application/pdf", size: 2048, reference: "OP-9", notes: "Devolución transferencia tardía" }),
  ])
}

const loadOrder = async (db: PGlite) =>
  (await db.query<Record<string, unknown>>("select * from ordenes where id=1")).rows[0]

test("approved_after_cancellation: pendiente en Admin, se reintegra una sola vez con el flujo existente y la acción desaparece", async () => {
  const db = await setup()
  try {
    const detected = (await record(db)).rows[0]
    assert.equal(detected.estado, "cancelado", "la venta nunca se reconfirma")
    assert.equal(detected.payment_status, "approved_after_cancellation")
    assert.equal(detected.financial_status, "refund_pending")
    assert.equal(Number(detected.external_amount_due), 700, "importe REALMENTE recibido, no el total")
    const audit = (await db.query<{ metadata: Record<string, unknown>; previous_status: string; new_status: string }>(
      "select metadata, previous_status, new_status from order_audit_events where action='transfer_payment_after_cancellation'")).rows[0]
    assert.equal(Number(audit.metadata.previousExternalAmountDue), 900)
    assert.deepEqual([audit.previous_status, audit.new_status], ["cancelled", "refund_pending"])

    // 1-2. Aparece como pendiente y se explica: pago recibido, pedido cancelado, no confirmar.
    const pending = await loadOrder(db)
    const actions = getAdminPendingOrderActions(pending as never)
    assert.ok(actions.some((action) => action.kind === "payment_conflict" && action.urgent))
    assert.ok(actions.some((action) => action.kind === "refund" && action.urgent))
    assert.ok(!actions.some((action) => action.kind === "invoice" || action.kind === "shipping"), "nunca facturar ni enviar")
    const panel = getCancellationPanelViewModel(pending as never)
    assert.equal(panel.state, "register_external_refund")
    assert.deepEqual(panel.primaryAction, { kind: "register_external_refund", label: "Registrar reintegro" })
    assert.equal(panel.amounts.amountToRefund, 700)
    assert.deepEqual(panel.paymentAfterCancellation, { receivedAmount: 700, paymentId: "pay-late-1" })
    assert.match(panel.helperText, /No confirmes la venta/)
    assert.doesNotMatch(panel.helperText, /nota de crédito/i)

    // No se puede "confirmar" ni registrar otro pago sobre el mismo pedido.
    await assert.rejects(record(db, "pay-late-2"), /NOT_ELIGIBLE/)

    // 3. Reintegro con el mecanismo existente, por el importe recibido.
    const operationId = randomUUID()
    const refunded = (await refund(db, "refund-1.pdf", operationId)).rows[0]
    assert.equal(refunded.financial_status, "refunded")
    assert.equal(Number(refunded.refund_amount), 700)
    assert.equal(refunded.estado, "cancelado", "no toca el estado ni el stock")

    // 4. Idempotencia: el mismo intento devuelve el pedido sin otro comprobante;
    // uno nuevo se rechaza.
    assert.equal((await refund(db, "refund-1.pdf", operationId)).rows[0].financial_status, "refunded")
    await assert.rejects(refund(db, "refund-2.pdf"), /CLAIM_REFUND_PENDING/)
    const proofs = await db.query<{ n: number }>("select count(*)::int as n from order_refund_proofs where order_id=1")
    assert.equal(proofs.rows[0].n, 1, "un solo reintegro")

    // 5-6. No duplica saldo ni beneficio: el flujo de reintegro no los toca.
    const resolved = await loadOrder(db)
    assert.equal(Number(resolved.credit_balance_used), 0)
    assert.equal(resolved.store_benefit_id, "benefit-1")
    assert.equal(resolved.transfer_matched_payment_id, "pay-late-1", "el payment.id sigue reclamado")

    // 8. Resuelto: la acción urgente desaparece.
    const after = getAdminPendingOrderActions(resolved as never)
    assert.ok(!after.some((action) => action.kind === "payment_conflict" || action.kind === "refund"))
    assert.equal(getCancellationPanelViewModel(resolved as never).state, "completed")
  } finally {
    await db.close()
  }
})

test("approved_after_cancellation: el registro es idempotente y no deja el pedido reintegrable dos veces", async () => {
  const db = await setup()
  try {
    await record(db)
    const again = (await record(db)).rows[0]
    assert.equal(again.financial_status, "refund_pending")
    const events = await db.query<{ n: number }>(
      "select count(*)::int as n from order_audit_events where action='transfer_payment_after_cancellation'")
    assert.equal(events.rows[0].n, 1)
    // Reintento del mismo payment.id: devuelve el pedido sin modificar nada.
    const replay = (await record(db, "pay-late-1", 900)).rows[0]
    assert.equal(Number(replay.external_amount_due), 700)
    assert.equal(replay.financial_status, "refund_pending")
    // Otro payment.id nunca se registra sobre el mismo pedido.
    await assert.rejects(record(db, "pay-late-9"), /NOT_ELIGIBLE/)
  } finally {
    await db.close()
  }
})
