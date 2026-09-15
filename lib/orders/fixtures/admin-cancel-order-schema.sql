-- Esquema aislado para ejercitar public.admin_cancel_order con PostgreSQL
-- real (PGlite). Sin credenciales, datos productivos ni efectos externos.
-- Dedicado (no reutiliza claim-schema.sql) para no acoplar este test a un
-- fixture compartido por otras suites -- sólo tiene las columnas que
-- admin_cancel_order realmente lee/escribe.

create role anon;
create role authenticated;
create role service_role bypassrls;

create schema auth;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
create function auth.role() returns text language sql stable as $$
  select nullif(current_setting('request.jwt.claim.role', true), '')
$$;

create table auth.users (id uuid primary key, email text);
create table public.profiles (id uuid primary key references auth.users(id), email text, rol text not null default 'cliente');

create table public.ordenes (
  id bigint primary key,
  usuario_id uuid,
  estado text,
  payment_status text,
  financial_status text,
  paid_at timestamptz,
  payment_confirmed_amount numeric,
  credit_balance_used numeric not null default 0,
  invoice_status text,
  invoice_cae text,
  invoice_number integer,
  invoice_point integer,
  tracking_number text,
  andreani_tracking text,
  andreani_envio_id text,
  andreani_estado text,
  cancelled_at timestamptz,
  cancellation_requested_at timestamptz,
  cancellation_requested_by uuid,
  refund_pending_at timestamptz,
  credit_note_required boolean
);

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

grant usage on schema public, auth to service_role;
grant all privileges on public.ordenes, public.order_audit_events, public.profiles, auth.users to service_role;
