begin;

-- Serialize retries and cumulative replacements before exposing this operation in UI.
alter function public.create_order_replacement(bigint,bigint,bigint,integer,text,uuid,text,text,text,bigint)
  rename to create_order_replacement_internal;
revoke all on function public.create_order_replacement_internal(bigint,bigint,bigint,integer,text,uuid,text,text,text,bigint)
  from public, anon, authenticated, service_role;

create function public.create_order_replacement(
  p_original_order_id bigint, p_original_order_item_id bigint,
  p_replacement_variant_id bigint, p_quantity integer, p_reason text,
  p_actor_id uuid, p_idempotency_key text,
  p_condition_note text default null, p_notes text default null, p_claim_id bigint default null
) returns public.order_replacements language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v_existing public.order_replacements; v_item public.orden_items; v_used integer; v_result public.order_replacements;
begin
  if auth.role() is distinct from 'service_role' or not exists (
    select 1 from public.profiles where id = p_actor_id and rol in ('admin','super_admin')
  ) then raise exception 'REPLACEMENT_FORBIDDEN'; end if;
  if p_idempotency_key is null or length(trim(p_idempotency_key)) < 8 then
    raise exception 'REPLACEMENT_IDEMPOTENCY_KEY_REQUIRED';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('replacement:' || p_idempotency_key, 0));
  select * into v_existing from public.order_replacements where idempotency_key = p_idempotency_key;
  if found then
    if v_existing.original_order_id <> p_original_order_id or v_existing.original_order_item_id <> p_original_order_item_id
      or v_existing.replacement_variant_id <> p_replacement_variant_id or v_existing.quantity <> p_quantity
      or v_existing.reason <> p_reason or v_existing.created_by <> p_actor_id
      or v_existing.claim_id is distinct from p_claim_id then raise exception 'REPLACEMENT_CONFLICT'; end if;
    return v_existing;
  end if;
  select * into v_item from public.orden_items where id = p_original_order_item_id and orden_id = p_original_order_id for update;
  if not found then raise exception 'REPLACEMENT_INVALID_ITEM'; end if;
  select coalesce(sum(quantity),0) into v_used from public.order_replacements where original_order_item_id = p_original_order_item_id;
  if p_quantity is null or p_quantity <= 0 or p_quantity + v_used > v_item.cantidad then
    raise exception 'REPLACEMENT_QUANTITY_EXCEEDED';
  end if;
  if p_reason <> 'garantia' and p_quantity + v_used > coalesce(v_item.return_restocked_quantity,0) + coalesce(v_item.return_written_off_quantity,0) then
    raise exception 'REPLACEMENT_REQUIRES_RECEIVED_ITEM';
  end if;
  if p_claim_id is not null and not exists (select 1 from public.order_claims where id = p_claim_id and order_id = p_original_order_id) then
    raise exception 'REPLACEMENT_INVALID_CLAIM';
  end if;
  if not exists (select 1 from public.producto_variantes v join public.productos p on p.id = v.producto_id
    where v.id = p_replacement_variant_id and v.activo and p.activo) then raise exception 'REPLACEMENT_UNAVAILABLE'; end if;
  v_result := public.create_order_replacement_internal(p_original_order_id,p_original_order_item_id,p_replacement_variant_id,
    p_quantity,p_reason,p_actor_id,p_idempotency_key,p_condition_note,p_notes,p_claim_id);
  return v_result;
end;
$$;
revoke all on function public.create_order_replacement(bigint,bigint,bigint,integer,text,uuid,text,text,text,bigint) from public, anon, authenticated;
grant execute on function public.create_order_replacement(bigint,bigint,bigint,integer,text,uuid,text,text,text,bigint) to service_role;
commit;
