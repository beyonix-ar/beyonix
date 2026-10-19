-- Simulación exclusiva de operaciones QA. El estado real de Andreani se
-- conserva en sus columnas propias; la simulación queda identificada y auditada.
alter table public.order_claim_shipments
  add column manual_status_override text
    check (manual_status_override in ('generada', 'en_transito', 'en_sucursal', 'entregada')),
  add column manual_status_override_at timestamptz,
  add column manual_status_override_by uuid references public.profiles(id);

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
  if p_status <> v_leg.status then
    select * into v_leg from public.apply_order_claim_shipment_tracking(
      p_shipment_id, p_status, false, null, null, null, null, null, null);
  end if;
  update public.order_claim_shipments
    set manual_status_override = p_status,
        manual_status_override_at = clock_timestamp(),
        manual_status_override_by = p_actor_id,
        updated_at = clock_timestamp()
    where id = p_shipment_id returning * into v_leg;
  perform public.log_order_claim_logistics(v_leg.claim_id, p_actor_id,
    'claim_shipment_test_status_override',
    jsonb_build_object('shipmentId', v_leg.id, 'direction', v_leg.direction,
      'status', p_status, 'note', left(v_note, 1000), 'environment', v_leg.environment));
  return v_leg;
end;
$$;

-- Mientras el override está activo, el sync conserva la observación real sin
-- mover el estado simulado ni disparar efectos de negocio por segunda vez.
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
  if v_leg.environment is distinct from 'QA' or v_leg.manual_status_override is null then
    raise exception 'CLAIM_SHIPMENT_TEST_UNAVAILABLE'; end if;
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

revoke all on function public.simulate_order_claim_shipment_status(bigint, uuid, text, text),
  public.observe_order_claim_shipment_tracking_in_test(bigint, text, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.simulate_order_claim_shipment_status(bigint, uuid, text, text),
  public.observe_order_claim_shipment_tracking_in_test(bigint, text, text, text, timestamptz)
  to service_role;
