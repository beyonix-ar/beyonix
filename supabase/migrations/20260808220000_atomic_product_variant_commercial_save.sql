-- Guardado comercial conjunto posterior a las reglas de activación.
-- 20260808120000 y 20260808210000 se consideran ya aplicadas e inmutables.

create or replace function public.update_product_commercial_configuration_atomic(
  p_product_id bigint,
  p_catalog jsonb,
  p_primary_sku text,
  p_variant_states jsonb,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product public.productos%rowtype;
  v_product_active boolean := coalesce((p_catalog ->> 'activo')::boolean, false);
  v_catalog_count integer;
  v_requested_count integer;
  v_distinct_count integer;
  v_invalid_count integer;
  v_variant_id bigint;
  v_variants jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'No tenés permisos para actualizar el catálogo.';
  end if;
  if p_product_id is null
     or jsonb_typeof(coalesce(p_catalog, 'null'::jsonb)) <> 'object'
     or jsonb_typeof(coalesce(p_variant_states, 'null'::jsonb)) <> 'array' then
    raise exception 'La configuración comercial no es válida.';
  end if;

  perform pg_advisory_xact_lock(93000, p_product_id::integer);

  select * into v_product
  from public.productos products
  where products.id = p_product_id
  for update;
  if not found then
    raise exception 'El producto ya no existe.';
  end if;

  perform 1
  from public.producto_variantes variants
  where variants.producto_id = p_product_id
  order by variants.orden, variants.id
  for update;

  select count(*) into v_catalog_count
  from public.producto_variantes variants
  where variants.producto_id = p_product_id;

  select
    count(*),
    count(distinct requested.id),
    count(*) filter (
      where requested.id is null or requested.active is null
    )
  into v_requested_count, v_distinct_count, v_invalid_count
  from jsonb_to_recordset(p_variant_states)
    as requested(id bigint, active boolean);

  if v_requested_count <> v_catalog_count
     or v_distinct_count <> v_requested_count
     or v_invalid_count > 0
     or exists (
       select 1
       from jsonb_to_recordset(p_variant_states)
         as requested(id bigint, active boolean)
       left join public.producto_variantes variants
         on variants.id = requested.id
        and variants.producto_id = p_product_id
       where variants.id is null
     ) then
    raise exception 'Los estados deben incluir exactamente todas las variantes del producto.';
  end if;

  if not v_product_active and exists (
    select 1
    from jsonb_to_recordset(p_variant_states)
      as requested(id bigint, active boolean)
    where requested.active
  ) then
    raise exception 'No podés activar una variante mientras el producto esté configurado como inactivo.';
  end if;

  if v_product_active and not exists (
    select 1
    from jsonb_to_recordset(p_variant_states)
      as requested(id bigint, active boolean)
    where requested.active
  ) then
    raise exception 'Activá al menos una variante.';
  end if;

  v_product := public.update_product_catalog_atomic(
    p_product_id,
    p_catalog,
    p_primary_sku,
    p_actor_id
  );

  if v_product_active then
    for v_variant_id in
      select requested.id
      from jsonb_to_recordset(p_variant_states)
        as requested(id bigint, active boolean)
      where requested.active
      order by requested.id
    loop
      perform public.assert_product_variant_can_activate(
        p_product_id,
        v_variant_id,
        false
      );
    end loop;
  end if;

  update public.producto_variantes variants
  set activo = requested.active
  from jsonb_to_recordset(p_variant_states)
    as requested(id bigint, active boolean)
  where variants.id = requested.id
    and variants.producto_id = p_product_id;

  if v_product_active then
    perform public.assert_product_can_activate(p_product_id);
    if not exists (
      select 1
      from public.producto_variantes variants
      where variants.producto_id = p_product_id
        and variants.activo
    ) then
      raise exception 'Activá al menos una variante.';
    end if;
  end if;

  select * into v_product
  from public.productos products
  where products.id = p_product_id;

  select coalesce(
    jsonb_agg(to_jsonb(variants) order by variants.orden, variants.id),
    '[]'::jsonb
  )
  into v_variants
  from public.producto_variantes variants
  where variants.producto_id = p_product_id;

  return jsonb_build_object(
    'product', to_jsonb(v_product),
    'variants', v_variants
  );
end;
$$;

comment on function public.update_product_commercial_configuration_atomic(
  bigint,
  jsonb,
  text,
  jsonb,
  uuid
) is
  'Valida y guarda catálogo, estado del producto y estados de todas sus variantes en una única transacción.';

revoke all on function public.update_product_commercial_configuration_atomic(
  bigint,
  jsonb,
  text,
  jsonb,
  uuid
) from public, anon, authenticated;
grant execute on function public.update_product_commercial_configuration_atomic(
  bigint,
  jsonb,
  text,
  jsonb,
  uuid
) to service_role;
