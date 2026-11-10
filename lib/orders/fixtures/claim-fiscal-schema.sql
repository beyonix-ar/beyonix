-- Complemento fiscal de claim-logistics-schema.sql para recorrer la cadena REAL
-- de ARCA (20260927110000, 20260927120000), liquidación Mercado Pago
-- (20261015120000, 20261015170000) y guardas fiscales (20261015180000) junto con
-- las migraciones de reclamos, en orden cronológico.
--
-- Columnas de la Factura C y restricciones REALES de order_credit_notes que esas
-- migraciones dan por existentes (baseline 2026-09-21 / 20260729181538).
-- Stubs sólo de predicados de factura y saldo ajenos a la NC (mismo criterio que
-- lib/arca/fiscal-obligation-guards-sql.test.ts); ninguna función de NC se stubea.

alter table ordenes
  add column if not exists invoice_voucher_type integer,
  add column if not exists invoice_requested_point integer,
  add column if not exists invoice_requested_type integer,
  add column if not exists invoice_requested_number bigint,
  add column if not exists invoice_queued_at timestamptz,
  add column if not exists credit_note_status text,
  add column if not exists credit_note_error text,
  add column if not exists order_change_status text;

alter table order_credit_notes
  alter column reason set not null,
  add column if not exists cae_due date,
  add column if not exists error text,
  -- Motivo comercial y desglose (20260729181539).
  add column if not exists operation_type text not null default 'devolucion_parcial'
    check (operation_type in ('devolucion_parcial', 'devolucion_total', 'cambio_producto', 'cancelacion_antes_despacho', 'reembolso_excepcional', 'ajuste_manual')),
  add column if not exists reason_code text not null default 'otro'
    check (reason_code in ('arrepentimiento', 'producto_defectuoso', 'producto_incorrecto', 'producto_faltante', 'producto_danado_envio', 'garantia_aprobada', 'cancelacion_antes_despacho', 'error_administrativo', 'otro')),
  add column if not exists reason_detail text,
  add column if not exists resolution_type text not null default 'saldo_favor'
    check (resolution_type in ('saldo_favor', 'medio_pago', 'transferencia', 'cambio_producto', 'reposicion_sin_costo', 'ajuste_administrativo')),
  add column if not exists original_shipping_paid numeric(12, 2) not null default 0,
  add column if not exists original_shipping_discounted numeric(12, 2) not null default 0,
  add column if not exists original_shipping_refunded numeric(12, 2) not null default 0,
  add column if not exists return_shipping_cost numeric(12, 2) not null default 0,
  add column if not exists new_shipping_cost numeric(12, 2) not null default 0,
  add column if not exists other_adjustment_amount numeric(12, 2) not null default 0,
  add constraint order_credit_notes_amount_breakdown check (total_amount = items_amount + manual_amount),
  add constraint order_credit_notes_authorization_complete check (
    status <> 'authorized' or (voucher_point is not null and voucher_number is not null
      and cae is not null and cae_due is not null and authorized_at is not null)),
  add constraint order_credit_notes_status_check check (status in ('processing', 'authorized', 'error')),
  add constraint order_credit_notes_total_amount_check check (total_amount > 0);
create unique index order_credit_notes_voucher_unique
  on order_credit_notes (voucher_point, voucher_number)
  where voucher_point is not null and voucher_number is not null;

create function inventory_order_consumes_stock(text, text) returns boolean language sql as $$ select true $$;
create function order_is_invoiceable(p_order ordenes) returns boolean language sql as $$
  select coalesce(p_order.estado, '') <> 'cancelado' and p_order.financial_status = 'payment_confirmed' and coalesce(p_order.total, 0) > 0 $$;
create function order_customer_credit_reversal_on_hold(p bigint) returns boolean language sql stable as $$
  select exists (select 1 from ordenes o where o.id = p and (o.invoice_queued_at is not null or o.invoice_cae is not null)) $$;

-- Tabla real (20260911170000).
create table public.mercadopago_order_refunds (
  id uuid primary key default gen_random_uuid(),
  order_id bigint not null references public.ordenes(id),
  payment_id text not null,
  amount numeric(12, 2) not null check (amount > 0),
  is_partial boolean not null default false,
  status text not null default 'processing'
    check (status in ('requested', 'processing', 'confirmed', 'failed', 'needs_reconciliation')),
  mp_refund_id text,
  idempotency_key text not null,
  requested_by uuid not null references auth.users(id),
  requested_at timestamptz not null default now(),
  completed_at timestamptz,
  error_code text,
  error_message text,
  attempt_count integer not null default 1,
  reconciliation_locked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
