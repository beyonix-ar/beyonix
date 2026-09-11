-- Fixture aislado para ejercitar reverse_customer_credit_topup y
-- credit_customer_credit_topup_from_mercadopago tal cual están definidas en
-- supabase/migrations/20260911130000_harden_customer_credit_rpc_authorization.sql
-- y en 20260911160000_reverse_customer_credit_topup_on_mp_reversal.sql.
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
grant select on auth.users to service_role;

create table public.customer_credit_movements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  movement_type text not null,
  amount numeric(12, 2) not null check (amount > 0),
  description text not null,
  source_type text not null,
  source_id text,
  order_id bigint,
  claim_id bigint,
  credit_note_id text,
  created_by uuid,
  related_movement_id uuid references public.customer_credit_movements(id) on delete set null,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  source_key text,
  resulting_balance numeric(12, 2)
);

create unique index customer_credit_movements_source_key_idx
  on public.customer_credit_movements (source_key)
  where source_key is not null;

create function public.customer_credit_movement_effect(p_movement_type text)
returns integer language sql immutable as $$
  select case
    when p_movement_type in ('credit', 'reversal', 'adjustment') then 1
    when p_movement_type in ('debit', 'expiration') then -1
    else 0
  end;
$$;

create table public.customer_credit_topups (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  amount numeric(12, 2),
  status text not null default 'pendiente_pago'
    check (status = any (array['pendiente_pago','en_revision','acreditado','rechazado','cancelado','revertido'])),
  credited_movement_id uuid references public.customer_credit_movements(id) on delete set null,
  reversed_movement_id uuid references public.customer_credit_movements(id) on delete set null,
  reversal_shortfall_amount numeric(12, 2),
  admin_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  payment_method text not null default 'mercadopago' check (payment_method = any (array['transfer','mercadopago'])),
  gross_amount numeric(12, 2),
  surcharge_percent numeric(12, 2) not null default 0,
  surcharge_amount numeric(12, 2) not null default 0,
  mercadopago_preference_id text,
  mercadopago_payment_id text,
  mercadopago_status text,
  external_reference text,
  request_fingerprint text
);

alter table public.customer_credit_movements
  add constraint customer_credit_movements_description_check
  check (length(trim(description)) between 3 and 500);

grant all privileges on public.customer_credit_movements, public.customer_credit_topups
  to service_role;
