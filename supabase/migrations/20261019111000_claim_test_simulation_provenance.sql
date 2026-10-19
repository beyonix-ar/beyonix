-- El marcador se escribe antes de la transición para que los mensajes y la
-- auditoría generados en esa transacción distingan la simulación QA.
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

create or replace function public.mark_simulated_claim_message()
returns trigger language plpgsql set search_path = public
as $$
declare
  v_shipment_id bigint;
  v_simulated boolean;
begin
  if new.system_key !~ '^(return_delivered|replacement_delivered|exchange_completed|exchange_at_branch):[0-9]+$' then
    return new;
  end if;
  v_shipment_id := split_part(new.system_key, ':', 2)::bigint;
  select manual_status_override is not null into v_simulated
    from public.order_claim_shipments where id = v_shipment_id and claim_id = new.claim_id;
  if not coalesce(v_simulated, false) then return new; end if;
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

drop trigger if exists mark_simulated_claim_message on public.order_claim_messages;
create trigger mark_simulated_claim_message
before insert on public.order_claim_messages
for each row execute function public.mark_simulated_claim_message();

create or replace function public.mark_simulated_claim_audit()
returns trigger language plpgsql set search_path = public
as $$
declare v_shipment_id bigint;
begin
  if new.action not in ('claim_shipment_delivered', 'claim_shipment_test_status_override')
     or coalesce(new.metadata->>'shipmentId', '') !~ '^[0-9]+$' then return new; end if;
  v_shipment_id := (new.metadata->>'shipmentId')::bigint;
  if exists (select 1 from public.order_claim_shipments
             where id = v_shipment_id and manual_status_override is not null) then
    new.metadata := coalesce(new.metadata, '{}'::jsonb) || jsonb_build_object('simulated', true);
  end if;
  return new;
end;
$$;

drop trigger if exists mark_simulated_claim_audit on public.order_audit_events;
create trigger mark_simulated_claim_audit
before insert on public.order_audit_events
for each row execute function public.mark_simulated_claim_audit();

revoke all on function public.mark_simulated_claim_message(), public.mark_simulated_claim_audit()
  from public, anon, authenticated;
