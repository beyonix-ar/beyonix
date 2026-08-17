-- Estado de creación idempotente de envíos Andreani B2C para órdenes reales.
-- Los campos andreani_envio_id / andreani_tracking / andreani_etiqueta_url /
-- andreani_estado / andreani_error ya existían; acá sólo se agrega lo
-- necesario para reclamar la creación de forma atómica y auditar intentos.

alter table public.ordenes
  add column if not exists andreani_creation_status text,
  add column if not exists andreani_creation_claim_token uuid,
  add column if not exists andreani_creation_claimed_at timestamptz,
  add column if not exists andreani_creation_attempts integer not null default 0,
  add column if not exists andreani_created_at timestamptz,
  add column if not exists andreani_contrato text;

alter table public.ordenes
  drop constraint if exists ordenes_andreani_creation_status_check;
alter table public.ordenes
  add constraint ordenes_andreani_creation_status_check
  check (andreani_creation_status is null or andreani_creation_status in ('claimed', 'created', 'failed'));

alter table public.ordenes
  drop constraint if exists ordenes_andreani_creation_attempts_check;
alter table public.ordenes
  add constraint ordenes_andreani_creation_attempts_check
  check (andreani_creation_attempts >= 0);

comment on column public.ordenes.andreani_creation_status is
  'Estado del intento de creación del envío B2C: claimed (en curso), created o failed.';
comment on column public.ordenes.andreani_creation_claim_token is
  'Token del intento en curso; permite liberar o reconciliar un reclamo atómico.';
comment on column public.ordenes.andreani_creation_claimed_at is
  'Momento en que se reclamó el intento de creación; permite recuperar reclamos vencidos.';
comment on column public.ordenes.andreani_creation_attempts is
  'Cantidad de intentos de creación del envío realizados para esta orden.';
comment on column public.ordenes.andreani_created_at is
  'Momento en que Andreani confirmó la creación del envío B2C.';
comment on column public.ordenes.andreani_contrato is
  'Contrato Andreani utilizado para crear el envío (modalidad domicilio).';

-- Reclamo atómico de creación: evita que doble clic, reintentos o acciones
-- administrativas concurrentes generen más de un envío Andreani por orden.
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

  update public.ordenes
  set
    andreani_creation_status = 'claimed',
    andreani_creation_claim_token = p_claim_token,
    andreani_creation_claimed_at = now(),
    andreani_creation_attempts = coalesce(andreani_creation_attempts, 0) + 1
  where id = p_order_id
    and nullif(btrim(coalesce(andreani_envio_id, '')), '') is null
    and (
      andreani_creation_status is null
      or andreani_creation_status = 'failed'
      or (
        andreani_creation_status = 'claimed'
        and andreani_creation_claimed_at < now() - interval '5 minutes'
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
  'Adquiere de forma atómica el derecho a crear el envío Andreani B2C de una orden que todavía no lo tiene.';

notify pgrst, 'reload schema';
