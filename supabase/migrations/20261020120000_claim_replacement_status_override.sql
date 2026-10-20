-- Estado operativo forzado del reenvío / reemplazo de un reclamo (super admin).
--
-- Reutiliza la infraestructura de la simulación QA (20261019110000 /
-- 20261019111000 / 20261019112000): el estado forzado vive en
-- manual_status_override, las columnas andreani_* siguen guardando lo que
-- informa Andreani y el sync, mientras haya override, sólo observa. Lo nuevo:
--   * manual_status_override_kind distingue la simulación QA del override
--     administrativo (cualquier ambiente) y manual_status_override_note
--     guarda el motivo;
--   * force_order_claim_shipment_status: sólo super admin, sólo el tramo
--     "reemplazo", motivo obligatorio, nunca hacia atrás ni sobre una
--     revisión Andreani abierta; "cancelada" usa cancel_order_claim_leg (con
--     sus guardas: sólo antes de que el envío se mueva);
--   * los efectos de negocio son los mismos que los de Andreani
--     (apply_order_claim_shipment_tracking), y el mensaje al cliente no dice
--     "Andreani informó" cuando el estado lo registró BEYONIX.
-- Nunca se modifica nada en Andreani.

alter table public.order_claim_shipments
  add column if not exists manual_status_override_kind text
    check (manual_status_override_kind in ('qa_simulation', 'admin_override')),
  add column if not exists manual_status_override_note text;

update public.order_claim_shipments
  set manual_status_override_kind = 'qa_simulation'
  where manual_status_override is not null and manual_status_override_kind is null;

alter table public.order_claim_shipments
  drop constraint if exists order_claim_shipments_override_kind_consistent;
alter table public.order_claim_shipments
  add constraint order_claim_shipments_override_kind_consistent
  check ((manual_status_override is null) = (manual_status_override_kind is null));

-- Simulación QA: igual que antes, ahora identificada como tal.
create or replace function public.simulate_order_claim_shipment_status(
  p_shipment_id bigint, p_actor_id uuid, p_status text, p_note text
)
returns public.order_claim_shipments
language plpgsql security definer set search_path = public
as $$
declare
  v_leg public.order_claim_shipments%rowtype;
  v_note text := btrim(coalesce(p_note, ''));
begin
  perform public.assert_order_claim_logistics_admin(p_actor_id);
  if p_status not in ('generada', 'en_transito', 'en_sucursal', 'entregada')
     or length(v_note) < 10 then raise exception 'CLAIM_SHIPMENT_INVALID'; end if;
  perform 1 from public.order_claims
    where id = (select claim_id from public.order_claim_shipments where id = p_shipment_id) for update;
  select * into v_leg from public.order_claim_shipments where id = p_shipment_id for update;
  if not found then raise exception 'CLAIM_SHIPMENT_NOT_FOUND'; end if;
  if v_leg.environment is distinct from 'QA' or v_leg.creation_status <> 'created'
     or v_leg.status = 'cancelada' or v_leg.review_required or v_leg.incident_open
     or v_leg.closed_at is not null then raise exception 'CLAIM_SHIPMENT_TEST_UNAVAILABLE'; end if;
  if public.order_claim_leg_rank(p_status) < public.order_claim_leg_rank(v_leg.status) then
    raise exception 'CLAIM_SHIPMENT_TEST_BACKWARD';
  end if;
  update public.order_claim_shipments
    set manual_status_override = p_status,
        manual_status_override_kind = 'qa_simulation',
        manual_status_override_note = left(v_note, 1000),
        manual_status_override_at = clock_timestamp(),
        manual_status_override_by = p_actor_id,
        updated_at = clock_timestamp()
    where id = p_shipment_id returning * into v_leg;
  if p_status <> v_leg.status then
    select * into v_leg from public.apply_order_claim_shipment_tracking(
      p_shipment_id, p_status, false, null, null, null, null, null, null);
  end if;
  perform public.log_order_claim_logistics(v_leg.claim_id, p_actor_id,
    'claim_shipment_test_status_override',
    jsonb_build_object('shipmentId', v_leg.id, 'direction', v_leg.direction,
      'status', p_status, 'note', left(v_note, 1000), 'environment', v_leg.environment));
  select * into v_leg from public.order_claim_shipments where id = p_shipment_id;
  return v_leg;
end;
$$;

create or replace function public.force_order_claim_shipment_status(
  p_shipment_id bigint, p_actor_id uuid, p_status text, p_note text
)
returns public.order_claim_shipments
language plpgsql security definer set search_path = public
as $$
declare
  v_leg public.order_claim_shipments%rowtype;
  v_previous text;
  v_note text := btrim(coalesce(p_note, ''));
begin
  if public.assert_order_claim_logistics_admin(p_actor_id) is distinct from 'super_admin' then
    raise exception 'CLAIM_SHIPMENT_FORCE_FORBIDDEN';
  end if;
  if p_status not in ('en_transito', 'en_sucursal', 'entregada', 'cancelada') then
    raise exception 'CLAIM_SHIPMENT_INVALID';
  end if;
  if length(v_note) < 10 then raise exception 'CLAIM_LOGISTICS_NOTE_REQUIRED'; end if;
  perform 1 from public.order_claims
    where id = (select claim_id from public.order_claim_shipments where id = p_shipment_id) for update;
  select * into v_leg from public.order_claim_shipments where id = p_shipment_id for update;
  if not found then raise exception 'CLAIM_SHIPMENT_NOT_FOUND'; end if;
  if v_leg.direction <> 'reemplazo' then raise exception 'CLAIM_SHIPMENT_FORCE_UNSUPPORTED'; end if;
  if exists (select 1 from public.order_claims where id = v_leg.claim_id and status in ('cerrado', 'rechazado')) then
    raise exception 'CLAIM_TERMINAL';
  end if;
  if v_leg.creation_status is distinct from 'created' then raise exception 'CLAIM_SHIPMENT_NOT_CREATED'; end if;
  if v_leg.status = 'cancelada' or v_leg.closed_at is not null then raise exception 'CLAIM_SHIPMENT_CLOSED'; end if;
  -- Una revisión Andreani abierta se resuelve con su propia acción: forzar
  -- encima la dejaría sin atender (y apply_* no mueve el estado con ella).
  if v_leg.review_required then raise exception 'CLAIM_SHIPMENT_FORCE_REVIEW_OPEN'; end if;
  v_previous := v_leg.status;

  if p_status = 'cancelada' then
    -- Mismas guardas que la cancelación normal: sólo si todavía no se movió.
    select * into v_leg from public.cancel_order_claim_leg(p_shipment_id, p_actor_id, v_note);
  else
    if public.order_claim_leg_rank(p_status) <= public.order_claim_leg_rank(v_leg.status) then
      raise exception 'CLAIM_SHIPMENT_FORCE_BACKWARD';
    end if;
    update public.order_claim_shipments
      set manual_status_override = p_status,
          manual_status_override_kind = 'admin_override',
          manual_status_override_note = left(v_note, 1000),
          manual_status_override_at = clock_timestamp(),
          manual_status_override_by = p_actor_id,
          updated_at = clock_timestamp()
      where id = p_shipment_id;
    select * into v_leg from public.apply_order_claim_shipment_tracking(
      p_shipment_id, p_status, false, null, null, null, null, null, null);
  end if;

  perform public.log_order_claim_logistics(v_leg.claim_id, p_actor_id,
    'claim_shipment_status_forced',
    jsonb_build_object('shipmentId', v_leg.id, 'direction', v_leg.direction,
      'previousStatus', v_previous, 'status', p_status, 'note', left(v_note, 1000),
      'environment', v_leg.environment, 'andreaniStatus', v_leg.andreani_estado));
  select * into v_leg from public.order_claim_shipments where id = p_shipment_id;
  return v_leg;
end;
$$;

-- Con override (QA o administrativo) el sync sólo observa lo que informa
-- Andreani: el estado operativo lo controla BEYONIX hasta un nuevo forzado.
create or replace function public.observe_order_claim_shipment_tracking_in_test(
  p_shipment_id bigint, p_estado text, p_tracking text,
  p_last_event text, p_last_event_at timestamptz
)
returns public.order_claim_shipments
language plpgsql security definer set search_path = public
as $$
declare v_leg public.order_claim_shipments%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  select * into v_leg from public.order_claim_shipments where id = p_shipment_id for update;
  if not found then raise exception 'CLAIM_SHIPMENT_NOT_FOUND'; end if;
  if v_leg.manual_status_override is null
     or (v_leg.manual_status_override_kind = 'qa_simulation' and v_leg.environment is distinct from 'QA') then
    raise exception 'CLAIM_SHIPMENT_TEST_UNAVAILABLE';
  end if;
  update public.order_claim_shipments set
    andreani_estado = coalesce(nullif(btrim(p_estado), ''), andreani_estado),
    andreani_tracking = coalesce(andreani_tracking, nullif(btrim(p_tracking), '')),
    andreani_last_event = case when p_last_event_at is not null and
      (andreani_last_event_at is null or p_last_event_at >= andreani_last_event_at)
      then coalesce(nullif(btrim(p_last_event), ''), andreani_last_event) else andreani_last_event end,
    andreani_last_event_at = greatest(andreani_last_event_at, p_last_event_at),
    last_checked_at = clock_timestamp(), updated_at = clock_timestamp()
  where id = p_shipment_id returning * into v_leg;
  return v_leg;
end;
$$;

-- Mensaje al cliente: la simulación QA se identifica como tal; un estado
-- forzado por BEYONIX no se atribuye a Andreani.
create or replace function public.mark_simulated_claim_message()
returns trigger language plpgsql set search_path = public
as $$
declare
  v_shipment_id bigint;
  v_kind text;
begin
  if new.system_key !~ '^(return_delivered|replacement_delivered|exchange_completed|exchange_at_branch):[0-9]+$' then
    return new;
  end if;
  v_shipment_id := split_part(new.system_key, ':', 2)::bigint;
  select manual_status_override_kind into v_kind
    from public.order_claim_shipments
    where id = v_shipment_id and claim_id = new.claim_id and manual_status_override is not null;
  if v_kind is null then return new; end if;
  if v_kind = 'admin_override' then
    if new.system_key like 'replacement_delivered:%' then
      new.message := 'Registramos la entrega de tu producto de reemplazo.';
    end if;
    return new;
  end if;
  if new.system_key like 'return_delivered:%' then
    new.message := 'Simulación QA: se marcó la devolución como entregada a BEYONIX. La recepción física y la inspección se registran por separado.';
  elsif new.system_key like 'replacement_delivered:%' then
    new.message := 'Simulación QA: se marcó el producto de reemplazo como entregado al cliente.';
  elsif new.system_key like 'exchange_completed:%' then
    new.message := 'Simulación QA: se marcó el cambio en sucursal como completado. La recepción física del original se registra por separado.';
  else
    new.message := 'Simulación QA: se marcó el producto nuevo como disponible en sucursal.';
  end if;
  return new;
end;
$$;

create or replace function public.mark_simulated_claim_audit()
returns trigger language plpgsql set search_path = public
as $$
declare
  v_shipment_id bigint;
  v_kind text;
begin
  if new.action not in ('claim_shipment_delivered', 'claim_shipment_test_status_override')
     or coalesce(new.metadata->>'shipmentId', '') !~ '^[0-9]+$' then return new; end if;
  v_shipment_id := (new.metadata->>'shipmentId')::bigint;
  select manual_status_override_kind into v_kind from public.order_claim_shipments
    where id = v_shipment_id and manual_status_override is not null;
  if v_kind = 'qa_simulation' then
    new.metadata := coalesce(new.metadata, '{}'::jsonb) || jsonb_build_object('simulated', true);
  elsif v_kind = 'admin_override' then
    new.metadata := coalesce(new.metadata, '{}'::jsonb) || jsonb_build_object('forced', true);
  end if;
  return new;
end;
$$;

revoke all on function public.force_order_claim_shipment_status(bigint, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.force_order_claim_shipment_status(bigint, uuid, text, text)
  to service_role;
revoke all on function public.simulate_order_claim_shipment_status(bigint, uuid, text, text),
  public.observe_order_claim_shipment_tracking_in_test(bigint, text, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.simulate_order_claim_shipment_status(bigint, uuid, text, text),
  public.observe_order_claim_shipment_tracking_in_test(bigint, text, text, text, timestamptz)
  to service_role;
revoke all on function public.mark_simulated_claim_message(), public.mark_simulated_claim_audit()
  from public, anon, authenticated;
