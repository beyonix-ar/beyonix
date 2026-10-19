-- El cron puede haber leído el tramo justo antes de una simulación. Resolver
-- la prioridad bajo el mismo candado de reclamo + shipment evita esa carrera.
create or replace function public.apply_order_claim_shipment_tracking_guarded(
  p_shipment_id bigint,
  p_phase text,
  p_incident boolean,
  p_estado text,
  p_tracking text,
  p_last_event text,
  p_last_event_at timestamptz,
  p_custody_since timestamptz,
  p_review_event text
)
returns public.order_claim_shipments
language plpgsql security definer set search_path = public
as $$
declare v_leg public.order_claim_shipments%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  perform 1 from public.order_claims
    where id = (select claim_id from public.order_claim_shipments where id = p_shipment_id) for update;
  select * into v_leg from public.order_claim_shipments where id = p_shipment_id for update;
  if not found then raise exception 'CLAIM_SHIPMENT_NOT_FOUND'; end if;
  if v_leg.manual_status_override is not null then
    return public.observe_order_claim_shipment_tracking_in_test(
      p_shipment_id, p_estado, p_tracking, p_last_event, p_last_event_at);
  end if;
  return public.apply_order_claim_shipment_tracking(
    p_shipment_id, p_phase, p_incident, p_estado, p_tracking,
    p_last_event, p_last_event_at, p_custody_since, p_review_event);
end;
$$;

revoke all on function public.apply_order_claim_shipment_tracking_guarded(
  bigint, text, boolean, text, text, text, timestamptz, timestamptz, text)
  from public, anon, authenticated;
grant execute on function public.apply_order_claim_shipment_tracking_guarded(
  bigint, text, boolean, text, text, text, timestamptz, timestamptz, text)
  to service_role;
