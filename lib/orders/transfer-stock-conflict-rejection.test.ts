import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

import { getAdminPendingOrderActions } from "./admin-pending-actions.ts"
import { getCancellationPanelViewModel } from "./cancellation-panel-view.ts"

// Fase 6 (bug): rechazar una transferencia YA COBRADA en conflicto de stock
// (auto_verified_stock_conflict) dejaba el pedido "pendiente / pending_payment
// / rechazado": dinero recibido sin obligación de reintegro ni acción en
// Admin. Ahora abre el reintegro existente. RPCs SQL reales: revisión manual
// (20260926150000), reversión de saldo (20260911150000) y reintegro sin nota
// de crédito (20260917130000).

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
      add column cancellation_requested_at timestamptz,
      add column refund_pending_at timestamptz,
      add column paid_at timestamptz,
      add column payment_proof_url text,
      add column payment_proof_file_name text,
      add column payment_confirmed_by uuid,
      add column payment_confirmed_at timestamptz,
      add column payment_confirmation_observation text,
      add column order_change_status text,
      add column order_change_extra_amount numeric,
      add column store_benefit_id text,
      add column transfer_matched_payment_id text unique,
      add column credit_balance_movement_id uuid,
      add column payment_composition jsonb;
    create table public.customer_credit_movements (
      id uuid primary key default gen_random_uuid(),
      user_id uuid, movement_type text, amount numeric, description text,
      source_type text, source_id text, order_id bigint, created_by uuid,
      related_movement_id uuid, source_key text unique, resulting_balance numeric,
      metadata jsonb, created_at timestamptz default now()
    );
    create function public.get_customer_credit_balance(p_user uuid) returns numeric language sql stable as $$
      select coalesce(sum(case when movement_type = 'debit' then -amount else amount end), 0)
      from public.customer_credit_movements where user_id = p_user
    $$;
    create table public.customer_store_benefits (
      id text primary key, status text, used_at timestamptz, used_order_id bigint
    );
  `)
  await db.exec(read("supabase/migrations/20260911150000_reverse_customer_credit_resets_order_due.sql"))
  await db.exec(read("supabase/migrations/20260923120000_atomic_manual_transfer_review.sql"))
  await db.exec(read("supabase/migrations/20260926150000_transfer_stock_conflict_rejection_opens_refund.sql"))
  await db.query("select set_config('request.jwt.claim.role','service_role',false)")
  await db.query("insert into auth.users(id) values($1),($2)", [admin, customer])
  await db.query("insert into public.profiles(id,rol) values($1,'admin'),($2,'cliente')", [admin, customer])
  // Total 900: 200 de saldo (debitado) + 700 por transferencia, identificada
  // por Mercado Pago (pay-1) pero sin stock para confirmar.
  const debit = (await db.query<{ id: string }>(`
    insert into customer_credit_movements (user_id, movement_type, amount, source_key, order_id)
    values ($1, 'credit', 500, 'seed', null), ($1, 'debit', 200, 'order:1:customer-credit:debit', 1)
    returning id`, [customer])).rows[1].id
  await db.query(`insert into customer_store_benefits (id, status, used_at, used_order_id)
    values ('benefit-1', 'used', now(), 1)`)
  await db.query(`insert into ordenes (id, usuario_id, total, original_total, external_amount_due, credit_balance_used,
      credit_balance_movement_id, payment_method_id, financial_status, estado, payment_status, credit_note_required,
      store_benefit_id, transfer_matched_payment_id)
    values (1, $1, 900, 900, 700, 200, $2, 'transferencia', 'pending_payment', 'pendiente',
      'auto_verified_stock_conflict', false, 'benefit-1', 'pay-1')`, [customer, debit])
  return db
}

const review = (db: PGlite, next: string, expected = "auto_verified_stock_conflict", observation = "Sin stock para cumplir") =>
  db.query<Record<string, unknown>>("select * from review_manual_transfer_payment(1, $1, $2, $3, $4)", [admin, expected, next, observation])

const loadOrder = async (db: PGlite) =>
  (await db.query<Record<string, unknown>>("select * from ordenes where id=1")).rows[0]

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
    JSON.stringify({ path, name: "reintegro.pdf", type: "application/pdf", size: 2048, reference: "OP-1", notes: "Sin stock" }),
  ])
}

test("rechazar una transferencia cobrada en conflicto de stock abre el reintegro por el importe recibido", async () => {
  const db = await setup()
  try {
    const rejected = (await review(db, "rechazado")).rows[0]
    assert.equal(rejected.estado, "cancelado")
    assert.equal(rejected.financial_status, "refund_pending", "antes quedaba pending_payment: dinero sin reintegro")
    assert.equal(rejected.payment_status, "auto_verified_stock_conflict", "Admin conserva la acción urgente")
    assert.equal(Number(rejected.external_amount_due), 700, "importe realmente recibido, no el total")
    assert.equal(Number(rejected.credit_balance_used), 0, "el saldo retenido vuelve al cliente")
    assert.ok(rejected.refund_pending_at && rejected.cancelled_at)
    assert.equal(rejected.transfer_matched_payment_id, "pay-1", "el payment.id sigue reclamado")

    const reversals = await db.query<{ n: number; amount: number }>(
      "select count(*)::int as n, max(amount) as amount from customer_credit_movements where movement_type='reversal'")
    assert.equal(reversals.rows[0].n, 1)
    assert.equal(Number(reversals.rows[0].amount), 200)
    const benefit = (await db.query<{ status: string; used_order_id: number | null }>(
      "select status, used_order_id from customer_store_benefits where id='benefit-1'")).rows[0]
    assert.deepEqual(benefit, { status: "active", used_order_id: null })

    const pending = await loadOrder(db)
    const actions = getAdminPendingOrderActions(pending as never)
    assert.ok(actions.some((action) => action.kind === "payment_conflict" && action.urgent))
    assert.ok(actions.some((action) => action.kind === "refund" && action.urgent))
    const panel = getCancellationPanelViewModel(pending as never)
    assert.equal(panel.state, "register_external_refund")
    assert.equal(panel.amounts.amountToRefund, 700)

    // Doble click: mismo resultado, sin otra reversión, beneficio ni auditoría.
    const retry = (await review(db, "rechazado")).rows[0]
    assert.equal(retry.financial_status, "refund_pending")
    assert.equal((await db.query<{ n: number }>(
      "select count(*)::int as n from customer_credit_movements where movement_type='reversal'")).rows[0].n, 1)
    assert.equal((await db.query<{ n: number }>(
      "select count(*)::int as n from order_audit_events where action='transfer_stock_conflict_rejected_refund_pending'")).rows[0].n, 1)
    // Ya no se puede "confirmar" un pedido cancelado con el reintegro abierto.
    await assert.rejects(review(db, "confirmado"), /TRANSFER_CANCELLATION_CONFLICT/)

    // Reintegro con el flujo existente, una sola vez.
    const refunded = (await refund(db, "refund-1.pdf")).rows[0]
    assert.equal(refunded.financial_status, "refunded")
    assert.equal(Number(refunded.refund_amount), 700)
    await assert.rejects(refund(db, "refund-2.pdf"), /CLAIM_REFUND_PENDING/)
    const resolved = await loadOrder(db)
    assert.ok(!getAdminPendingOrderActions(resolved as never).some((action) =>
      action.kind === "payment_conflict" || action.kind === "refund"))
  } finally {
    await db.close()
  }
})

test("rechazar un comprobante dudoso (sin cobro identificado) conserva el comportamiento anterior", async () => {
  const db = await setup()
  try {
    await db.query(`update ordenes set payment_status='en_revision', payment_proof_url='proofs/1.pdf',
      transfer_matched_payment_id=null where id=1`)
    const rejected = (await review(db, "rechazado", "en_revision", "Comprobante ilegible")).rows[0]
    assert.equal(rejected.estado, "pendiente")
    assert.equal(rejected.financial_status, "pending_payment")
    assert.equal(rejected.payment_status, "rechazado")
    assert.equal(Number(rejected.credit_balance_used), 0)
    assert.equal(Number(rejected.external_amount_due), 900, "el saldo devuelto vuelve a exigirse completo")
    const benefit = (await db.query<{ status: string }>("select status from customer_store_benefits where id='benefit-1'")).rows[0]
    assert.equal(benefit.status, "used", "fuera del conflicto cobrado no cambia nada más")
  } finally {
    await db.close()
  }
})

test("confirmar el conflicto (stock repuesto) sigue funcionando igual", async () => {
  const db = await setup()
  try {
    const confirmed = (await review(db, "confirmado", "auto_verified_stock_conflict", "Stock repuesto")).rows[0]
    assert.equal(confirmed.estado, "pagado")
    assert.equal(confirmed.financial_status, "payment_confirmed")
    assert.equal(Number(confirmed.payment_confirmed_amount), 700)
  } finally {
    await db.close()
  }
})
