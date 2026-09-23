-- Fixture aislado para ejercitar claim_mercadopago_order_preference tal cual
-- queda definida tras 20260815120000_mercadopago_checkout_attempt_idempotency.sql
-- + 20260924110000_mercadopago_claim_allows_rejected_cancelled.sql. Sin
-- conexión remota, credenciales ni datos reales.

create role anon;
create role authenticated;
create role service_role bypassrls;
create schema auth;
create function auth.role() returns text language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
$$;
grant usage on schema public, auth to anon, authenticated, service_role;

create table public.ordenes (
  id bigint primary key,
  usuario_id uuid,
  estado text not null default 'pendiente',
  financial_status text,
  payment_status text,
  payment_method_id text,
  mercadopago_checkout_fingerprint text,
  mercadopago_preference_id text,
  mercadopago_init_point text,
  mercadopago_preference_expires_at timestamptz,
  mercadopago_preference_claim_token uuid,
  mercadopago_preference_claimed_at timestamptz,
  mercadopago_preference_generation integer not null default 0
);
grant all privileges on public.ordenes to service_role;
