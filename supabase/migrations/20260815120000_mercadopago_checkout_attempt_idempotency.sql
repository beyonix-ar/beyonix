-- Intentos idempotentes de Checkout Pro para órdenes web.

alter table public.ordenes
  add column if not exists mercadopago_checkout_fingerprint text,
  add column if not exists mercadopago_request_fingerprint text,
  add column if not exists mercadopago_preference_id text,
  add column if not exists mercadopago_init_point text,
  add column if not exists mercadopago_preference_expires_at timestamptz,
  add column if not exists mercadopago_preference_claim_token uuid,
  add column if not exists mercadopago_preference_claimed_at timestamptz,
  add column if not exists mercadopago_preference_generation integer not null default 0;

create index if not exists ordenes_mercadopago_checkout_fingerprint_idx
  on public.ordenes (mercadopago_checkout_fingerprint, created_at desc)
  where mercadopago_checkout_fingerprint is not null;

create index if not exists ordenes_mercadopago_request_rate_idx
  on public.ordenes (mercadopago_request_fingerprint, created_at desc)
  where mercadopago_request_fingerprint is not null;

create index if not exists ordenes_mercadopago_expiration_idx
  on public.ordenes (mercadopago_preference_expires_at)
  where payment_method_id = 'mercadopago'
    and estado = 'pendiente';

alter table public.ordenes
  drop constraint if exists ordenes_mercadopago_preference_generation_check;
alter table public.ordenes
  add constraint ordenes_mercadopago_preference_generation_check
  check (mercadopago_preference_generation >= 0);

create or replace function public.claim_mercadopago_order_preference(
  p_order_id bigint,
  p_checkout_fingerprint text,
  p_claim_token uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_generation integer;
begin
  if auth.role() <> 'service_role' then
    raise exception 'No tenés permisos para renovar la preferencia.';
  end if;

  if p_order_id is null
     or nullif(btrim(coalesce(p_checkout_fingerprint, '')), '') is null
     or p_claim_token is null then
    raise exception 'MERCADOPAGO_PREFERENCE_CLAIM_INVALID';
  end if;

  update public.ordenes
  set
    mercadopago_preference_claim_token = p_claim_token,
    mercadopago_preference_claimed_at = now(),
    mercadopago_preference_generation =
      coalesce(mercadopago_preference_generation, 0) + 1,
    mercadopago_preference_id = null,
    mercadopago_init_point = null,
    mercadopago_preference_expires_at = null,
    payment_status = 'pending_checkout'
  where id = p_order_id
    and mercadopago_checkout_fingerprint = p_checkout_fingerprint
    and payment_method_id = 'mercadopago'
    and estado = 'pendiente'
    and coalesce(financial_status, 'pending_payment') = 'pending_payment'
    and coalesce(payment_status, 'pending_checkout') in (
      'pending_checkout',
      'preference_created',
      'preference_error'
    )
    and (
      mercadopago_preference_claimed_at is null
      or mercadopago_preference_claimed_at < now() - interval '5 minutes'
    )
    and (
      mercadopago_init_point is null
      or mercadopago_preference_expires_at is null
      or mercadopago_preference_expires_at <= now()
    )
  returning mercadopago_preference_generation into v_generation;

  return v_generation;
end;
$$;

revoke all on function public.claim_mercadopago_order_preference(bigint, text, uuid)
  from public, anon, authenticated;
grant execute on function public.claim_mercadopago_order_preference(bigint, text, uuid)
  to service_role;

comment on column public.ordenes.mercadopago_checkout_fingerprint is
  'Huella server-side del checkout validado; permite reutilizar de forma segura una orden pendiente.';
comment on column public.ordenes.mercadopago_init_point is
  'URL de Checkout Pro persistida para reintentos idempotentes.';
comment on function public.claim_mercadopago_order_preference(bigint, text, uuid) is
  'Adquiere de forma atómica el derecho a crear o renovar una preferencia para una orden pendiente.';
