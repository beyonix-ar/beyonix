-- Fixture aislado para ejercitar begin_mercadopago_order_refund,
-- record_mercadopago_order_refund_result y reconcile_mercadopago_order_refund
-- tal cual están definidas en
-- supabase/migrations/20260911170000_mercadopago_order_refunds.sql.
-- Sin conexión remota, credenciales ni datos reales.

create role anon;
create role authenticated;
create role service_role bypassrls;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$
  select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
$$;
create function auth.role() returns text language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
$$;
grant usage on schema public, auth to anon, authenticated, service_role;

create table auth.users (id uuid primary key);
grant select, insert on auth.users to service_role;

create table public.profiles (id uuid primary key references auth.users(id), rol text not null);
grant select, insert on public.profiles to service_role;

create table public.ordenes (
  id bigint primary key,
  usuario_id uuid,
  total numeric not null default 0,
  original_total numeric,
  payment_method_id text,
  payment_id text,
  payment_confirmed_amount numeric,
  financial_status text,
  estado text not null default 'pendiente',
  tracking_number text,
  andreani_tracking text,
  andreani_envio_id text,
  andreani_estado text,
  refund_method text,
  refund_amount numeric,
  refunded_at timestamptz,
  refunded_by uuid,
  credit_balance_used numeric not null default 0
);
grant all privileges on public.ordenes to service_role;

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

create table public.order_claims (
  id bigint generated always as identity primary key,
  order_id bigint not null references public.ordenes(id),
  user_id uuid references auth.users(id),
  claim_type text not null,
  status text not null default 'recibido',
  failure_type text,
  resolution text,
  admin_response text,
  description text not null default 'Solicitud de cancelación.',
  affected_items jsonb not null default '[]',
  admin_needs_action boolean not null default false,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
grant all privileges on public.order_claims to service_role;

create table public.order_claim_messages (
  id bigint generated always as identity primary key,
  claim_id bigint references public.order_claims(id),
  author_user_id uuid,
  author_role text,
  message text,
  created_at timestamptz not null default now()
);
grant all privileges on public.order_claim_messages to service_role;
