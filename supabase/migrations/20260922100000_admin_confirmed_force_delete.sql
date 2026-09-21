begin;

create table public.admin_destructive_operations (
  idempotency_key text primary key,
  actor_id uuid not null references auth.users(id),
  kind text not null check (kind in ('purchase', 'product', 'variant')),
  target_id text not null,
  impact jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.admin_destructive_operations enable row level security;
revoke all on public.admin_destructive_operations from public, anon, authenticated;
grant select, insert on public.admin_destructive_operations to service_role;

create or replace function public.admin_force_delete_impact(p_kind text, p_id text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_target jsonb;
  v_product_id bigint;
  v_variant_id bigint;
  v_product jsonb;
  v_variant jsonb;
  v_refs jsonb := '[]'::jsonb;
  v_ref record;
  v_count bigint;
  v_hash text;
  v_stock numeric := 0;
  v_received numeric := 0;
  v_affected jsonb := '{}'::jsonb;
  v_label text;
  v_confirmation text;
  v_target_table regclass;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'ADMIN_DELETE_FORBIDDEN'; end if;
  if p_kind = 'purchase' then
    select to_jsonb(t) into v_target from public.product_cost_entries t where id = p_id::uuid;
    v_product_id := (v_target->>'product_id')::bigint;
    v_variant_id := (v_target->>'variant_id')::bigint;
    v_received := case when v_target->>'reception_status' = 'anulada' then 0 else coalesce((v_target->>'received_quantity')::numeric, 0) end;
    v_affected := public.get_purchase_force_delete_impact(p_id::uuid);
    v_confirmation := 'ELIMINAR COMPRA ' || p_id;
    v_target_table := 'public.product_cost_entries'::regclass;
  elsif p_kind = 'product' then
    select to_jsonb(t) into v_target from public.productos t where id = p_id::bigint;
    v_product_id := p_id::bigint;
    v_target_table := 'public.productos'::regclass;
  elsif p_kind = 'variant' then
    select to_jsonb(t) into v_target from public.producto_variantes t where id = p_id::bigint;
    v_product_id := (v_target->>'producto_id')::bigint;
    v_variant_id := p_id::bigint;
    v_target_table := 'public.producto_variantes'::regclass;
  else raise exception 'ADMIN_DELETE_INVALID'; end if;
  if v_target is null then raise exception 'ADMIN_DELETE_NOT_FOUND'; end if;
  select to_jsonb(t) into v_product from public.productos t where id = v_product_id;
  select to_jsonb(t) into v_variant from public.producto_variantes t where id = v_variant_id;
  v_stock := coalesce((case when v_variant_id is not null then v_variant else v_product end ->>'stock')::numeric, 0);
  v_label := coalesce(v_product->>'nombre', v_target->>'article_name', 'Artículo histórico');
  if p_kind <> 'purchase' then
    v_confirmation := 'ELIMINAR ' || case when p_kind = 'product' then 'PRODUCTO ' else 'VARIANTE ' end ||
      coalesce(nullif(v_target->>'sku', ''), v_target->>'nombre');
  end if;

  -- Inventario real de referencias: incluye nuevas tablas con FK sin mantener
  -- una lista manual de relaciones. También incluye variantes al borrar padre.
  for v_ref in
    select c.conrelid::regclass as relation, a.attname as column_name,
      c.confrelid as parent, c.confdeltype as on_delete
    from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'f' and array_length(c.conkey, 1) = 1
      and (c.confrelid = v_target_table or (p_kind = 'product' and c.confrelid = 'public.producto_variantes'::regclass))
    order by c.conrelid, a.attname
  loop
    if p_kind = 'product' and v_ref.parent = 'public.producto_variantes'::regclass then
      execute format('select count(*), md5(coalesce(string_agg(to_jsonb(t)::text, ''|'' order by to_jsonb(t)::text), '''')) from %s t where %I in (select id from public.producto_variantes where producto_id = $1)', v_ref.relation, v_ref.column_name)
        into v_count, v_hash using v_product_id;
    else
      execute format('select count(*), md5(coalesce(string_agg(to_jsonb(t)::text, ''|'' order by to_jsonb(t)::text), '''')) from %s t where %I::text = $1', v_ref.relation, v_ref.column_name)
        into v_count, v_hash using p_id;
    end if;
    v_refs := v_refs || jsonb_build_array(jsonb_build_object('table', v_ref.relation::text, 'column', v_ref.column_name, 'count', v_count, 'fingerprint', v_hash, 'onDelete', v_ref.on_delete));
  end loop;
  -- These historical links intentionally have no FK and must also be disclosed.
  select count(*), md5(coalesce(string_agg(md5(to_jsonb(t)::text), '' order by t.id), ''))
    into v_count, v_hash from public.audit_logs t
    where t.table_name = case p_kind when 'purchase' then 'product_cost_entries' when 'product' then 'productos' else 'producto_variantes' end
      and t.record_id = p_id;
  v_refs := v_refs || jsonb_build_array(jsonb_build_object('table','audit_logs','column','record_id','count',v_count,'fingerprint',v_hash,'onDelete','preserve'));
  if p_kind = 'variant' then
    select count(*), md5(coalesce(string_agg(md5(to_jsonb(t)::text), '' order by t.id), ''))
      into v_count, v_hash from public.mercadolibre_sales t
      where to_jsonb(t)->'raw_data'->'beyonix_cost_mapping'->>'variant_id' = p_id;
    v_refs := v_refs || jsonb_build_array(jsonb_build_object('table','mercadolibre_sales','column','raw_data','count',v_count,'fingerprint',v_hash,'onDelete','unlink'));
  end if;
  return jsonb_build_object(
    'kind', p_kind, 'id', p_id, 'product', v_label,
    'variant', v_variant->>'nombre', 'sku', coalesce(v_variant->>'sku', v_product->>'sku', v_target->>'sku'),
    'receivedQuantity', v_received, 'totalCost', coalesce((v_target->>'total_cost')::numeric, 0),
    'currentStock', v_stock, 'projectedStock', case when p_kind = 'purchase' and v_product_id is not null then v_stock - v_received else 0 end,
    'affectedSales', coalesce((v_affected->>'affected_sales_count')::bigint, 0),
    'variants', (select count(*) from public.producto_variantes where producto_id = v_product_id),
    'references', v_refs, 'confirmation', v_confirmation,
    'fingerprint', md5(v_target::text || coalesce(v_product::text, '') || coalesce(v_variant::text, '') || v_refs::text || v_affected::text)
  );
end;
$$;

create or replace function public.admin_confirm_force_delete(
  p_kind text, p_id text, p_actor_id uuid, p_confirmation text,
  p_fingerprint text, p_idempotency_key text
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_impact jsonb;
  v_previous public.admin_destructive_operations%rowtype;
  v_product_id bigint;
begin
  if auth.role() is distinct from 'service_role' or not exists(select 1 from public.profiles where id = p_actor_id and rol = 'super_admin') then
    raise exception 'ADMIN_DELETE_FORBIDDEN';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 8 and 240 then raise exception 'ADMIN_DELETE_INVALID'; end if;
  perform pg_advisory_xact_lock(hashtextextended('admin-delete:' || p_idempotency_key, 0));
  select * into v_previous from public.admin_destructive_operations where idempotency_key = p_idempotency_key;
  if found then
    if v_previous.actor_id <> p_actor_id or v_previous.kind <> p_kind or v_previous.target_id <> p_id then raise exception 'ADMIN_DELETE_CONFLICT'; end if;
    return jsonb_build_object('deleted', true, 'replayed', true);
  end if;
  if p_kind = 'purchase' then
    select product_id into v_product_id from public.product_cost_entries where id = p_id::uuid for update;
  elsif p_kind = 'variant' then
    select producto_id into v_product_id from public.producto_variantes where id = p_id::bigint for update;
  elsif p_kind = 'product' then
    v_product_id := p_id::bigint;
  else raise exception 'ADMIN_DELETE_INVALID'; end if;
  if v_product_id is not null then perform pg_advisory_xact_lock(93000, v_product_id::integer); end if;
  perform 1 from public.productos where id = v_product_id for update;
  v_impact := public.admin_force_delete_impact(p_kind, p_id);
  if p_confirmation is distinct from v_impact->>'confirmation' then raise exception 'ADMIN_DELETE_CONFIRMATION'; end if;
  if p_fingerprint is distinct from v_impact->>'fingerprint' then raise exception 'ADMIN_DELETE_CONFLICT'; end if;
  if p_kind = 'purchase' then perform public.force_delete_purchase_super_admin(p_id::uuid, p_actor_id);
  elsif p_kind = 'product' then perform public.force_delete_product_super_admin(p_id::bigint, p_actor_id);
  else perform public.force_delete_product_variant_super_admin(p_id::bigint, p_actor_id); end if;
  insert into public.admin_destructive_operations(idempotency_key, actor_id, kind, target_id, impact)
    values(p_idempotency_key, p_actor_id, p_kind, p_id, v_impact);
  return jsonb_build_object('deleted', true, 'replayed', false);
end;
$$;
revoke all on function public.admin_force_delete_impact(text, text) from public, anon, authenticated;
revoke all on function public.admin_confirm_force_delete(text, text, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.admin_force_delete_impact(text, text) to service_role;
grant execute on function public.admin_confirm_force_delete(text, text, uuid, text, text, text) to service_role;
commit;
