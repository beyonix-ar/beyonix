-- Fixture aislado para ejercitar apply_customer_credit_to_order /
-- reverse_customer_credit_for_order tal cual están definidas en
-- supabase/migrations/20260911130000_harden_customer_credit_rpc_authorization.sql
-- y en la corrección 20260911150000_reverse_customer_credit_resets_order_due.sql.
-- Sin conexión remota, credenciales ni datos reales: sólo las columnas que
-- ambas funciones leen/escriben.

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

create table public.ordenes (
  id bigint primary key,
  usuario_id uuid references auth.users(id),
  total numeric not null default 0,
  original_total numeric,
  credit_balance_used numeric not null default 0,
  external_amount_due numeric,
  credit_balance_movement_id uuid,
  payment_composition jsonb not null default '{}'::jsonb,
  estado text not null default 'pendiente',
  financial_status text
);

create table public.customer_credit_movements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  movement_type text not null,
  amount numeric(12, 2) not null,
  description text not null,
  source_type text not null,
  source_id text,
  order_id bigint references public.ordenes(id) on delete set null,
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

grant all privileges on public.ordenes, public.customer_credit_movements
  to service_role;

alter table public.ordenes
  add constraint ordenes_credit_balance_movement_id_fkey
  foreign key (credit_balance_movement_id)
  references public.customer_credit_movements(id)
  on delete set null;

create function public.customer_credit_movement_effect(p_movement_type text)
returns integer language sql immutable as $$
  select case
    when p_movement_type in ('credit', 'reversal', 'adjustment') then 1
    when p_movement_type in ('debit', 'expiration') then -1
    else 0
  end;
$$;
