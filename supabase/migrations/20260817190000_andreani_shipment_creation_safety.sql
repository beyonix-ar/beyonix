-- Endurece la idempotencia de creación Andreani frente a resultados ambiguos.
-- Un timeout, 5xx o pérdida de respuesta puede ocurrir después de que Andreani
-- haya creado el preenvío. Esos casos no se reclaman nuevamente de forma
-- automática: requieren conciliación manual para evitar duplicados externos.

alter table public.ordenes
  drop constraint if exists ordenes_andreani_creation_status_check;

alter table public.ordenes
  add constraint ordenes_andreani_creation_status_check
  check (
    andreani_creation_status is null
    or andreani_creation_status in (
      'claimed',
      'created',
      'failed',
      'rejected',
      'reconciliation_required'
    )
  );

comment on column public.ordenes.andreani_creation_status is
  'Estado de creación B2C: claimed, created, failed recuperable, rejected permanente o reconciliation_required ante resultado externo ambiguo.';

create or replace function public.claim_andreani_shipment_creation(
  p_order_id bigint,
  p_claim_token uuid
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

  -- No se puede distinguir un proceso caído antes del POST de una respuesta
  -- perdida después de la creación. Al vencer, se bloquea para conciliación
  -- en vez de reciclar el claim y arriesgar un segundo envío externo.
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
    andreani_creation_attempts = coalesce(andreani_creation_attempts, 0) + 1
  where id = p_order_id
    and nullif(btrim(coalesce(andreani_envio_id, '')), '') is null
    and (andreani_creation_status is null or andreani_creation_status = 'failed')
    and lower(coalesce(estado, '')) <> 'cancelado'
    and lower(coalesce(financial_status, '')) not in (
      'cancelled',
      'refund_pending',
      'refunded'
    )
    and shipping_type = 'domicilio'
    and (
      paid_at is not null
      or lower(coalesce(payment_status, '')) in (
        'confirmado',
        'approved',
        'confirmed'
      )
      or lower(coalesce(estado, '')) in (
        'pagado',
        'enviado',
        'en_camino',
        'listo_retiro',
        'entregado'
      )
    )
  returning andreani_creation_attempts into v_attempts;

  return v_attempts;
end;
$$;

revoke all on function public.claim_andreani_shipment_creation(bigint, uuid)
  from public, anon, authenticated;
grant execute on function public.claim_andreani_shipment_creation(bigint, uuid)
  to service_role;

comment on function public.claim_andreani_shipment_creation(bigint, uuid) is
  'Reclama una única creación Andreani pagada y no cancelada; nunca recicla claims o resultados externos ambiguos.';

notify pgrst, 'reload schema';
