-- Completa las protecciones del ciclo Andreani sin modificar migraciones ya
-- aplicadas: la creación exige evidencia financiera y fiscal, y un intento
-- ambiguo/activo bloquea globalmente el pedido aunque cambie QA/PROD.

alter table public.ordenes
  add column if not exists andreani_tracking_checked_at timestamptz,
  add column if not exists andreani_tracking_event_at timestamptz;

comment on column public.ordenes.andreani_tracking_checked_at is
  'Última consulta exitosa del tracking Andreani.';
comment on column public.ordenes.andreani_tracking_event_at is
  'Fecha del último evento externo Andreani persistido.';

create or replace function public.claim_andreani_shipment_creation(
  p_order_id bigint,
  p_claim_token uuid,
  p_environment text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempts integer;
begin
  if auth.role() <> 'service_role' then
    raise exception 'No tenés permisos para generar este envío.';
  end if;

  if p_order_id is null or p_claim_token is null then
    raise exception 'ANDREANI_SHIPMENT_CLAIM_INVALID';
  end if;

  if p_environment not in ('QA', 'PROD') then
    raise exception 'ANDREANI_SHIPMENT_CLAIM_INVALID_ENVIRONMENT';
  end if;

  -- Un claim vencido es ambiguo aunque haya sido tomado en otro ambiente:
  -- no puede abrirse otro POST hasta conciliar el resultado externo.
  update public.ordenes
  set
    andreani_creation_status = 'reconciliation_required',
    andreani_creation_claim_token = null,
    andreani_error = coalesce(
      andreani_error,
      'El intento venció sin resultado persistido; requiere conciliación manual.'
    )
  where id = p_order_id
    and nullif(btrim(coalesce(andreani_envio_id, '')), '') is null
    and andreani_creation_status = 'claimed'
    and andreani_creation_claimed_at < now() - interval '5 minutes';

  update public.ordenes
  set
    andreani_creation_status = 'claimed',
    andreani_creation_claim_token = p_claim_token,
    andreani_creation_claimed_at = now(),
    andreani_creation_environment = p_environment,
    andreani_creation_attempts = coalesce(andreani_creation_attempts, 0) + 1
  where id = p_order_id
    and nullif(btrim(coalesce(andreani_envio_id, '')), '') is null
    and (
      andreani_creation_status is null
      or andreani_creation_status = 'failed'
      or (
        andreani_creation_status = 'rejected'
        and andreani_creation_environment is distinct from p_environment
      )
    )
    and lower(coalesce(estado, '')) <> 'cancelado'
    and lower(coalesce(financial_status, '')) not in (
      'cancellation_requested',
      'cancelled',
      'refund_pending',
      'refunded'
    )
    and shipping_type = 'domicilio'
    and (
      paid_at is not null
      or coalesce(payment_confirmed_amount, 0) > 0
      or lower(coalesce(payment_status, '')) in (
        'confirmado',
        'approved',
        'confirmed'
      )
      or lower(coalesce(financial_status, '')) = 'payment_confirmed'
    )
    and invoice_status = 'authorized'
    and nullif(btrim(coalesce(invoice_cae, '')), '') is not null
    and invoice_number is not null
    and invoice_point is not null
  returning andreani_creation_attempts into v_attempts;

  return v_attempts;
end;
$$;

revoke all on function public.claim_andreani_shipment_creation(bigint, uuid, text)
  from public, anon, authenticated;
grant execute on function public.claim_andreani_shipment_creation(bigint, uuid, text)
  to service_role;

comment on function public.claim_andreani_shipment_creation(bigint, uuid, text) is
  'Reclama atómicamente una creación Andreani para un pedido pagado, facturado y sin resultado externo ambiguo en ningún ambiente.';

notify pgrst, 'reload schema';
