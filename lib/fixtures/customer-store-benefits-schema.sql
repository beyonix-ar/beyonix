-- Fixture aislado para probar la carrera real de customer_store_benefits
-- (Fase 1, hardening P0 de ventas, Auditoría 2/7): dos requests concurrentes
-- podían ambas ver el mismo cupón 'active' antes de que cualquiera lo
-- marcara 'used'. Mismo shape que supabase/sql/038_customer_store_benefits.sql
-- (fuente real, columnas relevantes) para poder ejercitar el CAS real
-- (UPDATE ... WHERE status='active' ... RETURNING) que usan
-- claimActiveStoreBenefit/linkStoreBenefitToOrder/releaseStoreBenefitClaim.

create schema auth;
create table auth.users (id uuid primary key);

create table public.ordenes (
  id bigint generated always as identity primary key
);

create table public.customer_store_benefits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  used_order_id bigint references public.ordenes(id) on delete set null,
  benefit_type text not null check (benefit_type in ('gift_card', 'discount')),
  code text not null unique,
  percent integer not null check (percent between 1 and 100),
  status text not null default 'active' check (status in ('active', 'used', 'cancelled')),
  created_at timestamptz not null default now(),
  used_at timestamptz
);
