-- Confirmación física final del Bulto, con la misma validación y entrega auditada existentes.
alter table public.dispatch_batch_events drop constraint if exists dispatch_batch_events_action_check;
alter table public.dispatch_batch_events add constraint dispatch_batch_events_action_check
  check (action in ('created', 'order_added', 'closed', 'order_removed', 'handed_over',
    'order_verified', 'revalidation_required', 'reopened', 'mobile_control_confirmed'));

create or replace function public.confirm_dispatch_batch_mobile_control(p_batch_id bigint, p_actor_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_batch public.dispatch_batches%rowtype;
  v_item record;
  v_included bigint[] := array[]::bigint[];
  v_removed bigint[] := array[]::bigint[];
  v_parcels integer := 0;
begin
  perform public.assert_dispatch_operator(p_actor_id);
  select * into v_batch from public.dispatch_batches where id = p_batch_id for update;
  if not found then raise exception 'DISPATCH_BATCH_NOT_FOUND'; end if;
  if v_batch.status = 'handed_over' then
    return jsonb_build_object('batchId', p_batch_id, 'duplicate', true,
      'handedOverAt', v_batch.handed_over_at);
  end if;
  if v_batch.status not in ('open', 'closed') then raise exception 'DISPATCH_BATCH_NOT_CLOSED'; end if;
  for v_item in
    select i.id, i.order_id, i.package_id, p.parcel_count
    from public.dispatch_batch_items i
    join public.order_packages p on p.id = i.package_id
    where i.batch_id = p_batch_id and i.removed_at is null
    order by i.order_id
  loop
    perform 1 from public.ordenes where id = v_item.order_id for update;
    if cardinality(public.dispatch_order_block_reasons(v_item.order_id)) > 0
      or exists (select 1 from public.dispatch_blocks where order_id = v_item.order_id and resolved_at is null)
      or not exists (select 1 from public.order_packages
        where id = v_item.package_id and order_id = v_item.order_id and status = 'prepared')
    then raise exception 'DISPATCH_ORDER_BLOCKED' using detail = v_item.order_id::text; end if;
    v_included := array_append(v_included, v_item.order_id);
    v_parcels := v_parcels + coalesce(v_item.parcel_count, 0);
  end loop;
  if cardinality(v_included) = 0 then raise exception 'DISPATCH_BATCH_EMPTY'; end if;
  select coalesce(array_agg(order_id order by order_id), array[]::bigint[]) into v_removed
    from public.dispatch_batch_items where batch_id = p_batch_id and removed_at is not null;
  -- La confirmación presencial equivale a verificar físicamente los pedidos vigentes.
  update public.dispatch_batch_items set verified_at = now(), verified_by = p_actor_id,
    verification_method = 'manual_selection', verification_code = 'CONTROL-PRESENCIAL',
    verification_round = v_batch.verification_round
    where batch_id = p_batch_id and removed_at is null
      and (verified_at is null or verification_round is distinct from v_batch.verification_round);
  if v_batch.status = 'open' then
    v_batch := public.close_dispatch_batch(p_batch_id, p_actor_id);
  end if;
  v_batch := public.hand_over_dispatch_batch(p_batch_id, p_actor_id);
  insert into public.dispatch_batch_events(batch_id, actor_id, action, metadata)
    values (p_batch_id, p_actor_id, 'mobile_control_confirmed',
      jsonb_build_object('parcelCount', v_parcels, 'includedOrderIds', v_included,
        'removedOrderIds', v_removed, 'confirmedAt', v_batch.handed_over_at));
  return jsonb_build_object('batchId', p_batch_id, 'duplicate', false,
    'handedOverAt', v_batch.handed_over_at, 'parcelCount', v_parcels,
    'includedOrderIds', v_included, 'removedOrderIds', v_removed);
end $$;

revoke all on function public.confirm_dispatch_batch_mobile_control(bigint, uuid) from public, anon, authenticated;
grant execute on function public.confirm_dispatch_batch_mobile_control(bigint, uuid) to service_role;
