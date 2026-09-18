-- Fixture aislado para ejercitar, con las RPCs SQL REALES, el reintegro
-- externo sin nota de crédito (Fase 4, punto 1) y la política de NC para
-- Mercado Pago (Fase 4, punto 3): commit_order_refund_proof extendido y
-- begin_mercadopago_order_refund con el guard credit_note_required. Sin
-- conexión remota, credenciales ni datos reales.

create role anon;
create role authenticated;
create role service_role bypassrls;
create schema auth;
create schema storage;
create function auth.uid() returns uuid language sql stable as $$
  select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
$$;
create function auth.role() returns text language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
  )
$$;
grant usage on schema public, auth, storage to anon, authenticated, service_role;

create table auth.users (id uuid primary key);
grant select, insert on auth.users to service_role;

create table public.profiles (id uuid primary key references auth.users(id), rol text not null);
grant select, insert on public.profiles to service_role;

create table public.ordenes (
  id bigint primary key,
  usuario_id uuid,
  total numeric not null default 0,
  original_total numeric,
  external_amount_due numeric,
  credit_balance_used numeric not null default 0,
  payment_method_id text,
  payment_id text,
  payment_confirmed_amount numeric,
  financial_status text,
  estado text not null default 'pendiente',
  credit_note_required boolean not null default false,
  tracking_number text,
  andreani_tracking text,
  andreani_envio_id text,
  refund_proof_url text,
  refund_proof_file_name text,
  refund_proof_mime_type text,
  refund_proof_file_size bigint,
  refund_method text,
  refund_amount numeric,
  refund_uploaded_by uuid,
  refund_uploaded_at timestamptz,
  refunded_at timestamptz,
  refunded_by uuid
);
grant all privileges on public.ordenes to service_role;

create table public.order_credit_notes (
  id uuid primary key default gen_random_uuid(),
  order_id bigint references public.ordenes(id),
  status text default 'processing',
  destination text,
  cae text,
  total_amount numeric,
  settlement_status text default 'pendiente',
  management_status text,
  settlement_date date,
  settlement_reference text,
  updated_at timestamptz default now()
);
grant all privileges on public.order_credit_notes to service_role;

create table public.order_claim_operations (
  id uuid primary key,
  actor_id uuid not null,
  order_id bigint not null references public.ordenes(id),
  request_key text not null,
  status text not null default 'uploading',
  file_paths text[] not null default '{}',
  bucket_id text not null default 'order-claim-evidence',
  claim_id bigint,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '10 minutes'
);
grant all privileges on public.order_claim_operations to service_role;

create table public.order_refund_proofs (
  id bigint generated always as identity primary key,
  order_id bigint references public.ordenes(id),
  uploaded_by uuid,
  file_name text not null,
  file_path text not null,
  mime_type text not null,
  file_size bigint not null,
  amount numeric not null,
  method text,
  observation text,
  bank_reference text,
  refund_date date,
  created_at timestamptz not null default now()
);
grant all privileges on public.order_refund_proofs to service_role;

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
grant all privileges on public.order_audit_events to service_role;

create table public.customer_notifications (
  id bigint generated always as identity primary key,
  user_id uuid,
  type text,
  title text,
  body text,
  action_url text,
  order_id bigint,
  source_key text unique,
  is_read boolean default false,
  created_at timestamptz default now()
);
grant all privileges on public.customer_notifications to service_role;

create table storage.objects (
  bucket_id text,
  name text,
  primary key (bucket_id, name)
);
grant all privileges on storage.objects to service_role;

create table public.mercadopago_order_refunds (
  id uuid primary key default gen_random_uuid(),
  order_id bigint not null references public.ordenes(id),
  payment_id text not null,
  amount numeric not null,
  status text not null default 'requested',
  idempotency_key text not null unique,
  requested_by uuid,
  attempt_count integer not null default 1,
  mp_refund_id text,
  error_code text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
grant all privileges on public.mercadopago_order_refunds to service_role;
create unique index mercadopago_order_refunds_active_per_order_idx
  on public.mercadopago_order_refunds (order_id)
  where status in ('requested', 'processing', 'needs_reconciliation');
