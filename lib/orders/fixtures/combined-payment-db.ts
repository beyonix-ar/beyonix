import { readFileSync } from "node:fs"
import { join } from "node:path"
import { PGlite } from "@electric-sql/pglite"

// PostgreSQL en memoria con las RPCs REALES de NC, saldo, reintegro externo y
// cancelación automática (20261014130000 / 20261014140000). Lo comparten el
// test de pago combinado y el del worker de cancelaciones automáticas.

export const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8").replace(/\r\n/g, "\n")
const block = (source: string, start: string) => {
  const from = source.indexOf(start)
  return source.slice(from, source.indexOf("$$;", source.indexOf("as $$", from)) + 3)
}

export const admin = "10000000-0000-4000-8000-000000000003"
export const customer = "10000000-0000-4000-8000-000000000001"

export async function setupCombinedPaymentDb() {
  const db = new PGlite()
  await db.exec(read("lib/orders/fixtures/claim-schema.sql"))
  for (const path of [
    "supabase/migrations/20260816120000_atomic_order_claim_cancellation.sql",
    "supabase/migrations/20260905150000_claims_atomic_operations.sql",
    "supabase/migrations/20260906090000_claim_case_type_transitions.sql",
    "supabase/migrations/20260906100000_claims_final_security.sql",
    "supabase/migrations/20260906110000_claim_credit_note_snapshot.sql",
    "supabase/migrations/20260917120000_credit_note_refundable_external_cap.sql",
  ]) await db.exec(read(path))
  await db.exec(`
    alter table ordenes add column invoice_queued_at timestamptz, add column original_total numeric,
      add column credit_balance_movement_id uuid, add column payment_composition jsonb not null default '{}',
      add column payment_method_id text, add column payment_id text,
      add column andreani_handed_over_at timestamptz;
    alter table order_credit_notes add column created_at timestamptz default now(),
      add column finalized_at timestamptz;
    create table mercadopago_order_refunds(id uuid primary key default gen_random_uuid(), order_id bigint,
      payment_id text, amount numeric, status text, idempotency_key text, requested_by uuid not null,
      created_at timestamptz default now(), attempt_count integer default 1, mp_refund_id text);
    create table arca_auto_invoicing_control(id boolean primary key, enabled boolean, cutoff_at timestamptz);
    insert into arca_auto_invoicing_control values(true,true,now()-interval '1 day');
    alter table order_refund_proofs add column observation text, add column bank_reference text, add column refund_date date;
    alter table customer_credit_movements add column user_id uuid, add column amount numeric(12,2), add column description text,
      add column source_id text, add column created_by uuid, add column related_movement_id uuid, add column source_key text unique,
      add column resulting_balance numeric(12,2), add column metadata jsonb, add column credit_note_id text;
    create function get_customer_credit_balance(p_user uuid) returns numeric language sql stable as $$
      select coalesce(sum(case when movement_type in ('credit','reversal','adjustment') then amount else -amount end), 0)
      from customer_credit_movements where user_id = p_user $$;
  `)
  const obligation = read("supabase/migrations/20261014100000_invoice_obligation_survives_cancellation.sql")
  await db.exec(block(obligation, "create or replace function public.order_has_admin_direct_cancellation("))
  const refundPolicy = read("supabase/migrations/20260917130000_external_refund_without_credit_note_and_mp_nc_policy.sql")
  await db.exec(block(refundPolicy, "create or replace function public.commit_order_refund_proof("))
  await db.exec(read("supabase/migrations/20261014120000_customer_credit_reversal_after_credit_note.sql"))
  await db.exec(read("supabase/migrations/20261014130000_credit_note_fiscal_vs_money_split.sql"))
  await db.exec(read("supabase/migrations/20261014140000_automatic_cancellation_fiscal_refund.sql"))
  await db.query("select set_config('request.jwt.claim.role','service_role',false)")
  await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ role: "service_role" })])
  await db.query("insert into auth.users values($1,'a@example.test',now()),($2,'c@example.test',now())", [admin, customer])
  await db.query("insert into profiles(id,email,rol) values($1,'a@example.test','admin'),($2,'c@example.test','cliente')", [admin, customer])
  return db
}

/** Venta facturada de $100.000 cancelada por Admin: `external` cobrado afuera, el resto con saldo. */
export async function cancelledInvoicedSale(db: PGlite, id: number, external: number, method: "mercadopago" | "transferencia") {
  const credit = 100000 - external
  await db.query(`insert into ordenes(id,usuario_id,estado,total,original_total,invoice_status,invoice_cae,invoice_number,invoice_point,
      payment_confirmed_amount,external_amount_due,credit_balance_used,financial_status,payment_method_id,invoice_queued_at,credit_note_required)
    values ($1,$2,'cancelado',100000,100000,'authorized','CAE',$3,1,$4,$5,$6,'refund_pending',$7,now(),true)`,
    [id, customer, id, external, external, credit, method])
  await db.query(`insert into order_audit_events(order_id,actor_type,action,metadata)
    values ($1,'admin','order_cancelled_refund_pending','{"source":"admin_direct_cancellation"}'::jsonb)`, [id])
  // Lo que hace la cancelación: pide la reversión del saldo (queda retenida).
  await db.query("select * from reverse_customer_credit_for_order($1,'Cancelación',$2)", [id, admin])
}
