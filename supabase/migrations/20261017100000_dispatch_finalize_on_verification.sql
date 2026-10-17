-- La última lectura válida finaliza el Bulto en la misma transacción.
-- Conserva status='closed' para el esquema y los Bultos históricos; no registra
-- una entrega física a Andreani ni modifica ordenes.andreani_handed_over_at.
create or replace function public.verify_and_finalize_dispatch_batch(
  p_batch_id bigint, p_code text, p_method text, p_actor_id uuid,
  p_request_key uuid, p_order_id bigint default null)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_result jsonb;
  v_batch public.dispatch_batches%rowtype;
  v_item record;
begin
  v_result := public.verify_dispatch_batch_order(
    p_batch_id, p_code, p_method, p_actor_id, p_request_key, p_order_id);
  if (v_result->>'expected')::integer > 0
     and (v_result->>'verified')::integer = (v_result->>'expected')::integer then
    -- Un Bulto histórico cerrado puede requerir un nuevo control tras un retiro.
    -- La RPC original retorna temprano para closed; revalidamos todas sus órdenes.
    select * into v_batch from public.dispatch_batches where id = p_batch_id for update;
    if v_batch.status = 'closed' then
      for v_item in select i.order_id, i.package_id, i.verified_at, i.verification_round
        from public.dispatch_batch_items i
        where i.batch_id = p_batch_id and i.removed_at is null order by i.order_id loop
        perform 1 from public.ordenes where id = v_item.order_id for update;
        if cardinality(public.dispatch_order_block_reasons(v_item.order_id)) > 0
           or exists (select 1 from public.dispatch_blocks where order_id = v_item.order_id and resolved_at is null)
           or not exists (select 1 from public.order_packages
                          where id = v_item.package_id and order_id = v_item.order_id and status = 'prepared')
           then raise exception 'DISPATCH_ORDER_BLOCKED' using detail = v_item.order_id::text; end if;
        if v_item.verified_at is null or v_item.verification_round is distinct from v_batch.verification_round
           then raise exception 'DISPATCH_ORDERS_UNVERIFIED' using detail = v_item.order_id::text; end if;
      end loop;
      return v_result || jsonb_build_object('finalized', true);
    end if;
    v_batch := public.close_dispatch_batch(p_batch_id, p_actor_id);
    return v_result || jsonb_build_object('finalized', v_batch.status in ('closed', 'handed_over'));
  end if;
  return v_result || jsonb_build_object('finalized', false);
end $$;

revoke all on function public.verify_and_finalize_dispatch_batch(bigint, text, text, uuid, uuid, bigint)
  from public, anon, authenticated;
grant execute on function public.verify_and_finalize_dispatch_batch(bigint, text, text, uuid, uuid, bigint)
  to service_role;

alter table public.dispatch_batch_events drop constraint if exists dispatch_batch_events_action_check;
alter table public.dispatch_batch_events add constraint dispatch_batch_events_action_check
  check (action in ('created', 'order_added', 'closed', 'order_removed', 'handed_over',
    'order_verified', 'revalidation_required', 'reopened'));

create or replace function public.reopen_dispatch_batch(
  p_batch_id bigint, p_actor_id uuid, p_reason text)
returns public.dispatch_batches language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v_batch public.dispatch_batches%rowtype;
begin
  perform public.assert_dispatch_operator(p_actor_id);
  if not exists (select 1 from public.profiles where id = p_actor_id and rol = 'super_admin')
     then raise exception 'DISPATCH_FORBIDDEN'; end if;
  if length(btrim(coalesce(p_reason, ''))) not between 10 and 1000
     then raise exception 'DISPATCH_REASON_REQUIRED'; end if;
  select * into v_batch from public.dispatch_batches where id = p_batch_id for update;
  if not found then raise exception 'DISPATCH_BATCH_NOT_FOUND'; end if;
  if v_batch.status = 'handed_over' then raise exception 'DISPATCH_BATCH_ALREADY_HANDED_OVER'; end if;
  if v_batch.status = 'open' then return v_batch; end if;
  update public.dispatch_batches set status = 'open', closed_at = null, closed_by = null,
    verification_round = verification_round + 1
    where id = p_batch_id returning * into v_batch;
  insert into public.dispatch_batch_events(batch_id, actor_id, action, metadata)
    values (p_batch_id, p_actor_id, 'reopened',
      jsonb_build_object('reason', btrim(p_reason), 'previousStatus', 'closed',
        'newStatus', 'open', 'round', v_batch.verification_round));
  return v_batch;
end $$;

revoke all on function public.reopen_dispatch_batch(bigint, uuid, text)
  from public, anon, authenticated;
grant execute on function public.reopen_dispatch_batch(bigint, uuid, text)
  to service_role;

notify pgrst, 'reload schema';
