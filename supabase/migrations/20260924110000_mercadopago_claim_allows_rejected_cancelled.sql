-- Corrige un bug de checkout: un intento de Mercado Pago con pago RECHAZADO
-- o CANCELADO desde Checkout Pro queda con `estado='pendiente'` para
-- siempre (el webhook, a propósito, sólo persiste `payment_status` en esa
-- rama -- ver app/api/mercadopago/webhook/route.ts, `payment.status !==
-- "approved"`), porque un pago puede reintentarse con otro medio sobre la
-- MISMA preferencia. Eso es correcto, pero `claim_mercadopago_order_preference`
-- sólo permitía reclamar una preferencia nueva cuando `payment_status` era
-- 'pending_checkout' / 'preference_created' / 'preference_error': un cliente
-- cuyo pago fue rechazado y vuelve a intentar quedaba con el checkout
-- bloqueando cualquier compra nueva del mismo carrito (índice único
-- `ordenes_customer_checkout_fingerprint_pending_unique`,
-- 20260918130000_customer_checkout_fingerprint_dedup.sql) sin ninguna forma
-- de reclamar una preferencia fresca sobre esa misma orden.
--
-- Se agregan 'rejected' y 'cancelled' a la lista de `payment_status`
-- reclamables -- ningún otro valor cambia: un pago realmente aprobado
-- ('approved', vía isMercadoPagoOrderAlreadyConfirmed en la app) o con
-- conflicto de stock ('approved_stock_conflict') sigue totalmente
-- excluido, porque en esos casos ya hubo dinero real cobrado.

begin;

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
      'preference_error',
      'rejected',
      'cancelled'
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

commit;
