-- El estado del producto controla la publicaci?n general; el de la variante,
-- su disponibilidad. Ninguno cambia autom?ticamente al otro.
-- ALTER DEFAULT no modifica productos existentes.
alter table public.productos alter column activo set default false;

drop trigger if exists sync_product_variant_commercial_state on public.productos;
drop function if exists public.sync_product_variant_commercial_state();

-- La pol?tica p?blica exige ambos estados aun al consultar variantes
-- directamente. Las pol?ticas de administrador siguen siendo independientes.
drop policy if exists producto_variantes_public_select on public.producto_variantes;
create policy producto_variantes_public_select
on public.producto_variantes
for select
using (
  activo = true
  and exists (
    select 1 from public.productos products
    where products.id = producto_variantes.producto_id
      and products.activo = true
  )
);

create or replace function public.set_product_variant_state_atomic(
  p_product_id bigint,
  p_variant_id bigint,
  p_active boolean,
  p_actor_id uuid
)
returns public.producto_variantes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_variant public.producto_variantes%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception 'No tenés permisos para cambiar el estado de la variante.';
  end if;
  perform pg_advisory_xact_lock(93000, p_product_id::integer);

  perform 1
  from public.productos products
  where products.id = p_product_id
  for update;
  if not found then
    raise exception 'El producto ya no existe.';
  end if;

  select * into v_variant
  from public.producto_variantes variants
  where variants.id = p_variant_id
    and variants.producto_id = p_product_id
  for update;
  if not found then
    raise exception 'La variante ya no existe.';
  end if;
  if p_active then
    perform public.assert_product_variant_can_activate(
      p_product_id,
      p_variant_id,
      false
    );
  end if;

  perform set_config('beyonix.actor_id', p_actor_id::text, true);
  update public.producto_variantes
  set activo = p_active
  where id = p_variant_id
  returning * into v_variant;

  return v_variant;
end;
$$;

create or replace function public.reorder_product_variants_atomic(
  p_product_id bigint,
  p_variant_ids jsonb,
  p_actor_id uuid
)
returns setof public.producto_variantes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_requested_count integer;
  v_catalog_count integer;
begin
  if auth.role() <> 'service_role' then
    raise exception 'No tenés permisos para reordenar variantes.';
  end if;
  if jsonb_typeof(coalesce(p_variant_ids, 'null'::jsonb)) <> 'array' then
    raise exception 'El orden de variantes no es válido.';
  end if;

  perform pg_advisory_xact_lock(93000, p_product_id::integer);
  select count(*) into v_catalog_count
  from public.producto_variantes variants
  where variants.producto_id = p_product_id;
  select count(*) into v_requested_count
  from jsonb_array_elements_text(p_variant_ids);

  if v_requested_count <> v_catalog_count
     or (
       select count(distinct value::bigint)
       from jsonb_array_elements_text(p_variant_ids)
     ) <> v_requested_count
     or exists (
       select 1
       from jsonb_array_elements_text(p_variant_ids) requested(value)
       left join public.producto_variantes variants
         on variants.id = requested.value::bigint
        and variants.producto_id = p_product_id
       where variants.id is null
     ) then
    raise exception 'El orden debe incluir exactamente todas las variantes del producto.';
  end if;

  perform set_config('beyonix.actor_id', p_actor_id::text, true);
  update public.producto_variantes variants
  set orden = requested.position::integer
  from jsonb_array_elements_text(p_variant_ids)
    with ordinality as requested(value, position)
  where variants.id = requested.value::bigint
    and variants.producto_id = p_product_id;

  if exists (
    select 1 from public.productos products
    where products.id = p_product_id and products.activo
  ) then
    perform public.assert_product_can_activate(p_product_id);
  end if;

  perform public.sync_product_primary_variant_image(p_product_id);
  return query
  select variants.*
  from public.producto_variantes variants
  where variants.producto_id = p_product_id
  order by variants.orden, variants.id;
end;
$$;

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

create or replace function public.validate_product_commercial_state()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product_active boolean;
  v_activating boolean := coalesce(new.activo, false)
    and (tg_op = 'INSERT' or not coalesce(old.activo, false));
  v_error text;
begin
  select products.activo into v_product_active
  from public.productos products
  where products.id = new.id;

  if coalesce(v_product_active, false) then
    v_error := public.product_listing_error(new.id, v_activating);
    if v_error is not null then
      raise exception '%', v_error;
    end if;
  end if;
  return null;
end;
$$;

create or replace function public.validate_variant_commercial_state()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product_id bigint := case
    when tg_op = 'DELETE' then old.producto_id
    else new.producto_id
  end;
  v_variant_id bigint := case
    when tg_op = 'DELETE' then old.id
    else new.id
  end;
  v_variant_active boolean;
  v_activating boolean := tg_op <> 'DELETE'
    and coalesce(new.activo, false)
    and (tg_op = 'INSERT' or not coalesce(old.activo, false));
  v_error text;
begin
  if tg_op <> 'DELETE' then
    select variants.producto_id, variants.activo
    into v_product_id, v_variant_active
    from public.producto_variantes variants
    where variants.id = v_variant_id;
  else
    v_variant_active := false;
  end if;

  if coalesce(v_variant_active, false) then
    v_error := public.product_variant_listing_error(
      v_product_id,
      v_variant_id,
      false,
      v_activating
    );
    if v_error is not null then
      raise exception '%', v_error;
    end if;
  end if;

  if exists (
    select 1 from public.productos products
    where products.id = v_product_id and products.activo
  ) then
    v_error := public.product_listing_error(v_product_id, false);
    if v_error is not null then
      raise exception '%', v_error;
    end if;
  end if;

  return null;
end;
$$;
