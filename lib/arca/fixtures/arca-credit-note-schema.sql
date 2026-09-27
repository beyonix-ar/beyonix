-- Fixture aislado para el hardening de Notas de Crédito C (20260927110000).
-- order_credit_notes con las restricciones REALES de producción que importan
-- acá (baseline 2026-09-21): una sola NC 'processing' en toda la tienda,
-- comprobante único y autorización completa.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role bypassrls; end if;
end;
$$;

create schema if not exists auth;
create or replace function auth.role() returns text language sql stable as $$
  select nullif(current_setting('request.jwt.claim.role', true), '')
$$;
grant usage on schema public, auth to anon, authenticated, service_role;

-- Columnas de la Factura C asociada: la NC se emite en su mismo ambiente
-- (20260927120000).
create table public.ordenes (
  id bigint primary key,
  credit_note_status text,
  credit_note_error text,
  invoice_status text,
  invoice_point integer,
  invoice_number bigint,
  invoice_voucher_type integer,
  invoice_cae text,
  invoice_requested_point integer,
  invoice_requested_type integer,
  invoice_requested_number bigint
);

create table public.order_credit_notes (
  id uuid primary key default gen_random_uuid(),
  order_id bigint not null references public.ordenes(id),
  status text not null default 'processing',
  destination text not null default 'external_refund',
  reason text not null default 'Devolución',
  items_amount numeric(12,2) not null default 0,
  manual_amount numeric(12,2) not null default 0,
  total_amount numeric(12,2) not null,
  invoice_point integer not null,
  invoice_number bigint not null,
  voucher_point integer,
  voucher_number bigint,
  cae text,
  cae_due date,
  error text,
  authorized_at timestamptz,
  updated_at timestamptz not null default now(),
  management_status text not null default 'nota_credito_pendiente',
  settlement_status text not null default 'pendiente',
  constraint order_credit_notes_amount_breakdown check (total_amount = items_amount + manual_amount),
  constraint order_credit_notes_authorization_complete check (
    status <> 'authorized' or (voucher_point is not null and voucher_number is not null
      and cae is not null and cae_due is not null and authorized_at is not null)),
  constraint order_credit_notes_status_check check (status in ('processing', 'authorized', 'error')),
  constraint order_credit_notes_total_amount_check check (total_amount > 0)
);
create unique index order_credit_notes_single_processing
  on public.order_credit_notes (status) where status = 'processing';
create unique index order_credit_notes_voucher_unique
  on public.order_credit_notes (voucher_point, voucher_number)
  where voucher_point is not null and voucher_number is not null;

create table public.order_audit_events (
  id bigint generated always as identity primary key,
  order_id bigint,
  actor_type text,
  actor_id uuid,
  action text,
  previous_status text,
  new_status text,
  metadata jsonb,
  created_at timestamptz not null default now()
);

grant all privileges on public.ordenes, public.order_credit_notes, public.order_audit_events to service_role;
