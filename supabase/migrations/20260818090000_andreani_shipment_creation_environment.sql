-- Distingue el ambiente Andreani (QA/PROD) del último intento de creación
-- por orden. Sin esto, un rechazo QA quedaba indistinguible de "PROD ya
-- fue intentado" y bloqueaba para siempre un primer intento PROD legítimo.

alter table public.ordenes
  add column if not exists andreani_creation_environment text;

alter table public.ordenes
  drop constraint if exists ordenes_andreani_creation_environment_check;
alter table public.ordenes
  add constraint ordenes_andreani_creation_environment_check
  check (andreani_creation_environment is null or andreani_creation_environment in ('QA', 'PROD'));

comment on column public.ordenes.andreani_creation_environment is
  'Ambiente Andreani (QA/PROD) del último intento de creación registrado en andreani_creation_status.';

-- Todo intento previo a esta migración fue necesariamente QA (la creación
-- estaba forzada a QA en el código); se backfillea para que la nueva
-- comparación de ambiente en la RPC no trate estos registros como
-- "ambiente desconocido" y bloquee un primer intento PROD legítimo.
update public.ordenes
set andreani_creation_environment = 'QA'
where andreani_creation_status is not null
  and andreani_creation_environment is null;

drop function if exists public.claim_andreani_shipment_creation(bigint, uuid);

-- Reclamo atómico consciente del ambiente: un estado 'rejected',
-- 'reconciliation_required' o 'claimed' registrado para un ambiente
-- distinto del solicitado NUNCA bloquea el nuevo intento (evita interpretar
-- "QA rejected" como "PROD ya intentado"). Dentro del MISMO ambiente se
-- mantienen todas las protecciones existentes contra doble clic,
-- reintentos y concurrencia.
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

  -- No se puede distinguir un proceso caído antes del POST de una respuesta
  -- perdida después de la creación. Al vencer un claim del MISMO ambiente,
  -- se bloquea para conciliación en vez de reciclarlo automáticamente.
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
    and andreani_creation_environment = p_environment
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
      or andreani_creation_environment is distinct from p_environment
    )
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

revoke all on function public.claim_andreani_shipment_creation(bigint, uuid, text)
  from public, anon, authenticated;
grant execute on function public.claim_andreani_shipment_creation(bigint, uuid, text)
  to service_role;

comment on function public.claim_andreani_shipment_creation(bigint, uuid, text) is
  'Reclama una única creación Andreani B2C por pedido y ambiente; un rechazo/estado de otro ambiente nunca bloquea el intento solicitado, y dentro del mismo ambiente preserva todas las protecciones de idempotencia.';

notify pgrst, 'reload schema';
