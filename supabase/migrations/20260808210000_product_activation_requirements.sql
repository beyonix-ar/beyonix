-- Reglas comerciales posteriores a 20260808120000_atomic_product_catalog_workflow.sql.
-- La migración base ya existe en producción; este archivo sólo reemplaza las
-- validaciones de activación y agrega sus garantías de integridad.

create or replace function public.product_variant_activation_error(
  p_product_id bigint,
  p_variant_id bigint,
  p_primary boolean default false
)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_variant public.producto_variantes%rowtype;
  v_subject text := case
    when p_primary then 'La variante principal'
    else 'La variante'
  end;
  v_allocated integer;
begin
  select * into v_variant
  from public.producto_variantes variants
  where variants.id = p_variant_id
    and variants.producto_id = p_product_id;

  if not found then
    return case
      when p_primary then 'Creá al menos una variante.'
      else 'La variante ya no existe.'
    end;
  end if;
  if nullif(btrim(coalesce(v_variant.nombre, '')), '') is null then
    return v_subject || ' necesita un nombre.';
  end if;
  if nullif(btrim(coalesce(v_variant.sku, '')), '') is null then
    return v_subject || ' necesita un SKU.';
  end if;
  if v_variant.color_hex is null
     or v_variant.color_hex !~ '^#[0-9A-Fa-f]{6}$' then
    return v_subject || ' necesita un color.';
  end if;
  if jsonb_typeof(coalesce(v_variant.imagenes, '[]'::jsonb)) <> 'array' then
    return v_subject || ' necesita al menos una imagen.';
  end if;
  if not exists (
    select 1
    from jsonb_array_elements_text(v_variant.imagenes) images(url)
    where nullif(btrim(images.url), '') is not null
  ) then
    return v_subject || ' necesita al menos una imagen.';
  end if;

  select coalesce(allocations.quantity, 0)
  into v_allocated
  from public.inventory_variant_allocations allocations
  where allocations.product_id = p_product_id
    and allocations.variant_id = p_variant_id;

  if coalesce(v_allocated, 0) <= 0 then
    return v_subject || ' necesita stock asignado.';
  end if;

  return null;
end;
$$;

create or replace function public.assert_product_variant_can_activate(
  p_product_id bigint,
  p_variant_id bigint,
  p_primary boolean default false
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_error text;
begin
  v_error := public.product_variant_activation_error(
    p_product_id,
    p_variant_id,
    p_primary
  );
  if v_error is not null then
    raise exception '%', v_error;
  end if;
end;
$$;

create or replace function public.product_activation_error(
  p_product_id bigint
)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_product public.productos%rowtype;
  v_primary_variant_id bigint;
  v_catalog_sku text;
  v_variant_error text;
begin
  select * into v_product
  from public.productos products
  where products.id = p_product_id;

  if not found then
    return 'El producto ya no existe.';
  end if;
  if nullif(btrim(coalesce(v_product.nombre, '')), '') is null then
    return 'Falta completar el título.';
  end if;

  select variants.id, variants.sku
  into v_primary_variant_id, v_catalog_sku
  from public.producto_variantes variants
  where variants.producto_id = p_product_id
  order by variants.orden, variants.id
  limit 1;

  v_catalog_sku := coalesce(v_catalog_sku, v_product.sku);
  if nullif(btrim(coalesce(v_catalog_sku, '')), '') is null then
    return 'El producto necesita un SKU.';
  end if;
  if coalesce(v_product.precio, 0) <= 0 then
    return 'El precio debe ser mayor a $0.';
  end if;
  if v_product.categoria_id is null
     or not exists (
       select 1 from public.categorias categories
       where categories.id = v_product.categoria_id
     ) then
    return 'Seleccioná una categoría.';
  end if;
  if nullif(btrim(coalesce(v_product.descripcion, '')), '') is null then
    return 'Completá la descripción.';
  end if;
  if not exists (
    select 1
    from public.producto_especificaciones specifications
    where specifications.producto_id = p_product_id
      and specifications.activo
      and nullif(btrim(coalesce(specifications.icono, '')), '') is not null
      and nullif(btrim(coalesce(specifications.texto, '')), '') is not null
  ) then
    return 'Agregá al menos una especificación activa.';
  end if;
  if coalesce(v_product.peso_empaquetado_kg, 0) <= 0
     or coalesce(v_product.alto_paquete_cm, 0) <= 0
     or coalesce(v_product.ancho_paquete_cm, 0) <= 0
     or coalesce(v_product.largo_paquete_cm, 0) <= 0 then
    return 'Completá peso, profundidad, ancho y largo.';
  end if;
  if v_primary_variant_id is null then
    return 'Creá al menos una variante.';
  end if;

  v_variant_error := public.product_variant_activation_error(
    p_product_id,
    v_primary_variant_id,
    true
  );
  return v_variant_error;
end;
$$;

create or replace function public.assert_product_can_activate(
  p_product_id bigint
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_error text;
begin
  v_error := public.product_activation_error(p_product_id);
  if v_error is not null then
    raise exception '%', v_error;
  end if;
end;
$$;

create or replace function public.update_product_catalog_atomic(
  p_product_id bigint,
  p_catalog jsonb,
  p_primary_sku text,
  p_actor_id uuid
)
returns public.productos
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product public.productos%rowtype;
  v_primary_variant_id bigint;
  v_name text := nullif(btrim(coalesce(p_catalog ->> 'nombre', '')), '');
  v_slug text := nullif(btrim(coalesce(p_catalog ->> 'slug', '')), '');
  v_price numeric := nullif(p_catalog ->> 'precio', '')::numeric;
  v_active boolean := coalesce((p_catalog ->> 'activo')::boolean, false);
  v_category_id bigint := nullif(p_catalog ->> 'categoria_id', '')::bigint;
begin
  if auth.role() <> 'service_role' then
    raise exception 'No tenés permisos para actualizar el catálogo.';
  end if;
  if p_product_id is null
     or jsonb_typeof(coalesce(p_catalog, 'null'::jsonb)) <> 'object'
     or v_slug is null then
    raise exception 'Los datos comerciales del producto no son válidos.';
  end if;
  if v_active and v_name is null then
    raise exception 'Falta completar el título.';
  end if;
  if v_name is null then
    raise exception 'Los datos comerciales del producto no son válidos.';
  end if;
  if v_active and coalesce(v_price, 0) <= 0 then
    raise exception 'El precio debe ser mayor a $0.';
  end if;
  if v_price is null or v_price < 0 then
    raise exception 'Los datos comerciales del producto no son válidos.';
  end if;
  if v_active and (
    v_category_id is null
    or not exists (
      select 1 from public.categorias categories
      where categories.id = v_category_id
    )
  ) then
    raise exception 'Seleccioná una categoría.';
  end if;
  if v_active and (
    coalesce(nullif(p_catalog ->> 'peso_empaquetado_kg', '')::numeric, 0) <= 0
    or coalesce(nullif(p_catalog ->> 'alto_paquete_cm', '')::numeric, 0) <= 0
    or coalesce(nullif(p_catalog ->> 'ancho_paquete_cm', '')::numeric, 0) <= 0
    or coalesce(nullif(p_catalog ->> 'largo_paquete_cm', '')::numeric, 0) <= 0
  ) then
    raise exception 'Completá peso, profundidad, ancho y largo.';
  end if;
  perform pg_advisory_xact_lock(93000, p_product_id::integer);
  select * into v_product
  from public.productos products
  where products.id = p_product_id
  for update;
  if not found then
    raise exception 'El producto ya no existe.';
  end if;

  select variants.id
  into v_primary_variant_id
  from public.producto_variantes variants
  where variants.producto_id = p_product_id
  order by variants.orden, variants.id
  limit 1
  for update;

  perform set_config('beyonix.actor_id', p_actor_id::text, true);

  if v_primary_variant_id is not null then
    update public.producto_variantes
    set sku = nullif(left(btrim(coalesce(p_primary_sku, '')), 120), '')
    where id = v_primary_variant_id;
  end if;

  update public.productos products
  set nombre = left(v_name, 240),
      sku = case
        when v_primary_variant_id is null
          then nullif(left(btrim(coalesce(p_primary_sku, '')), 120), '')
        else null
      end,
      slug = left(v_slug, 240),
      descripcion = nullif(p_catalog ->> 'descripcion', ''),
      video_url = nullif(p_catalog ->> 'video_url', ''),
      precio = v_price,
      precio_anterior = nullif(p_catalog ->> 'precio_anterior', '')::numeric,
      descuento = nullif(p_catalog ->> 'descuento', '')::numeric,
      cuotas_sin_interes = coalesce(
        (p_catalog ->> 'cuotas_sin_interes')::boolean,
        false
      ),
      cuotas_maximas = nullif(p_catalog ->> 'cuotas_maximas', '')::integer,
      promo_event_id = nullif(p_catalog ->> 'promo_event_id', '')::uuid,
      promo_original_precio = nullif(
        p_catalog ->> 'promo_original_precio',
        ''
      )::numeric,
      promo_original_precio_anterior = nullif(
        p_catalog ->> 'promo_original_precio_anterior',
        ''
      )::numeric,
      promo_original_descuento = nullif(
        p_catalog ->> 'promo_original_descuento',
        ''
      )::numeric,
      promo_original_cuotas_sin_interes = nullif(
        p_catalog ->> 'promo_original_cuotas_sin_interes',
        ''
      )::boolean,
      promo_original_cuotas_maximas = nullif(
        p_catalog ->> 'promo_original_cuotas_maximas',
        ''
      )::integer,
      categoria_id = v_category_id,
      destacado = coalesce((p_catalog ->> 'destacado')::boolean, false),
      activo = v_active,
      peso_empaquetado_kg = nullif(p_catalog ->> 'peso_empaquetado_kg', '')::numeric,
      alto_paquete_cm = nullif(p_catalog ->> 'alto_paquete_cm', '')::numeric,
      ancho_paquete_cm = nullif(p_catalog ->> 'ancho_paquete_cm', '')::numeric,
      largo_paquete_cm = nullif(p_catalog ->> 'largo_paquete_cm', '')::numeric
  where products.id = p_product_id
  returning * into v_product;

  if v_active then
    perform public.assert_product_can_activate(p_product_id);
  end if;

  return v_product;
end;
$$;

create or replace function public.set_product_commercial_state_atomic(
  p_product_id bigint,
  p_active boolean,
  p_actor_id uuid
)
returns public.productos
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product public.productos%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception 'No tenés permisos para cambiar el estado comercial.';
  end if;
  if p_product_id is null or p_active is null then
    raise exception 'El estado comercial no es válido.';
  end if;

  perform pg_advisory_xact_lock(93000, p_product_id::integer);
  select * into v_product
  from public.productos products
  where products.id = p_product_id
  for update;
  if not found then
    raise exception 'El producto ya no existe.';
  end if;
  if p_active then
    perform public.assert_product_can_activate(p_product_id);
  end if;

  perform set_config('beyonix.actor_id', p_actor_id::text, true);
  update public.productos
  set activo = p_active
  where id = p_product_id
  returning * into v_product;

  return v_product;
end;
$$;

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
  v_product_active boolean;
  v_variant public.producto_variantes%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception 'No tenés permisos para cambiar el estado de la variante.';
  end if;
  perform pg_advisory_xact_lock(93000, p_product_id::integer);

  select products.activo into v_product_active
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
  if p_active and not v_product_active then
    raise exception 'No podés activar esta variante porque el producto está inactivo.';
  end if;
  if p_active then
    perform public.assert_product_variant_can_activate(
      p_product_id,
      p_variant_id,
      false
    );
  end if;
  if not p_active
     and v_product_active
     and not exists (
       select 1
       from public.producto_variantes variants
       where variants.producto_id = p_product_id
         and variants.id <> p_variant_id
         and variants.activo
     ) then
    raise exception 'No podés desactivar la única variante activa. Desactivá primero el producto.';
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
    update public.producto_variantes variants
    set activo = true
    where variants.id = (
      select primary_variant.id
      from public.producto_variantes primary_variant
      where primary_variant.producto_id = p_product_id
      order by primary_variant.orden, primary_variant.id
      limit 1
    );
  end if;

  perform public.sync_product_primary_variant_image(p_product_id);
  return query
  select variants.*
  from public.producto_variantes variants
  where variants.producto_id = p_product_id
  order by variants.orden, variants.id;
end;
$$;

create or replace function public.create_product_variant_with_allocation_v2(
  p_product_id bigint, p_name text, p_sku text, p_color_hex text,
  p_images jsonb, p_quantity integer, p_actor_id uuid,
  p_peso_empaquetado_kg numeric, p_alto_paquete_cm numeric,
  p_ancho_paquete_cm numeric, p_largo_paquete_cm numeric
)
returns public.producto_variantes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_variant public.producto_variantes%rowtype;
begin
  v_variant := public.create_product_variant_with_allocation(
    p_product_id, p_name, p_sku, p_color_hex, p_images, p_quantity, p_actor_id
  );
  update public.producto_variantes
  set activo = false,
      peso_empaquetado_kg = p_peso_empaquetado_kg,
      alto_paquete_cm = p_alto_paquete_cm,
      ancho_paquete_cm = p_ancho_paquete_cm,
      largo_paquete_cm = p_largo_paquete_cm
  where id = v_variant.id
  returning * into v_variant;
  perform public.sync_product_primary_variant_image(p_product_id);
  return v_variant;
end;
$$;

create or replace function public.sync_product_variant_commercial_state()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not new.activo then
    update public.producto_variantes variants
    set activo = false
    where variants.producto_id = new.id
      and variants.activo;
  elsif tg_op = 'UPDATE' and not coalesce(old.activo, false) then
    update public.producto_variantes variants
    set activo = true
    where variants.id = (
      select primary_variant.id
      from public.producto_variantes primary_variant
      where primary_variant.producto_id = new.id
      order by primary_variant.orden, primary_variant.id
      limit 1
    );
  end if;

  return new;
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
begin
  select products.activo into v_product_active
  from public.productos products
  where products.id = new.id;

  if coalesce(v_product_active, false) then
    perform public.assert_product_can_activate(new.id);
    if not exists (
      select 1
      from public.producto_variantes variants
      where variants.producto_id = new.id
        and variants.activo
    ) then
      raise exception 'El producto necesita al menos una variante activa.';
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
    if not exists (
      select 1 from public.productos products
      where products.id = v_product_id and products.activo
    ) then
      raise exception 'No podés activar esta variante porque el producto está inactivo.';
    end if;
    perform public.assert_product_variant_can_activate(
      v_product_id,
      v_variant_id,
      false
    );
  end if;

  if exists (
    select 1 from public.productos products
    where products.id = v_product_id and products.activo
  ) then
    perform public.assert_product_can_activate(v_product_id);
    if not exists (
      select 1 from public.producto_variantes variants
      where variants.producto_id = v_product_id and variants.activo
    ) then
      raise exception 'No podés desactivar la única variante activa. Desactivá primero el producto.';
    end if;
  end if;

  return null;
end;
$$;

create or replace function public.validate_variant_allocation_commercial_state()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product_id bigint := case
    when tg_op = 'DELETE' then old.product_id
    else new.product_id
  end;
  v_variant_id bigint := case
    when tg_op = 'DELETE' then old.variant_id
    else new.variant_id
  end;
begin
  if exists (
    select 1
    from public.producto_variantes variants
    where variants.id = v_variant_id
      and variants.producto_id = v_product_id
      and variants.activo
  ) then
    perform public.assert_product_variant_can_activate(
      v_product_id,
      v_variant_id,
      false
    );
  end if;
  return null;
end;
$$;

create or replace function public.validate_product_specification_commercial_state()
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
begin
  if exists (
    select 1 from public.productos products
    where products.id = v_product_id and products.activo
  ) then
    perform public.assert_product_can_activate(v_product_id);
  end if;
  return null;
end;
$$;

drop trigger if exists sync_product_variant_commercial_state
  on public.productos;
create trigger sync_product_variant_commercial_state
after insert or update of activo
on public.productos
for each row execute function public.sync_product_variant_commercial_state();

drop trigger if exists validate_product_commercial_state
  on public.productos;
create constraint trigger validate_product_commercial_state
after insert or update
on public.productos
deferrable initially deferred
for each row execute function public.validate_product_commercial_state();

drop trigger if exists validate_variant_commercial_state
  on public.producto_variantes;
create constraint trigger validate_variant_commercial_state
after insert or update or delete
on public.producto_variantes
deferrable initially deferred
for each row execute function public.validate_variant_commercial_state();

drop trigger if exists validate_variant_allocation_commercial_state
  on public.inventory_variant_allocations;
create constraint trigger validate_variant_allocation_commercial_state
after insert or update or delete
on public.inventory_variant_allocations
deferrable initially deferred
for each row execute function public.validate_variant_allocation_commercial_state();

drop trigger if exists validate_product_specification_commercial_state
  on public.producto_especificaciones;
create constraint trigger validate_product_specification_commercial_state
after insert or update or delete
on public.producto_especificaciones
deferrable initially deferred
for each row execute function public.validate_product_specification_commercial_state();

-- Normaliza exclusivamente estados comerciales históricos. No elimina ni
-- modifica imágenes, SKU, stock, asignaciones, orden, medidas o especificaciones.
update public.producto_variantes variants
set activo = false
where variants.activo
  and (
    not exists (
      select 1 from public.productos products
      where products.id = variants.producto_id and products.activo
    )
    or public.product_variant_activation_error(
      variants.producto_id,
      variants.id,
      false
    ) is not null
  );

update public.productos products
set activo = false
where products.activo
  and public.product_activation_error(products.id) is not null;

update public.producto_variantes variants
set activo = false
where variants.activo
  and exists (
    select 1 from public.productos products
    where products.id = variants.producto_id and not products.activo
  );

update public.producto_variantes variants
set activo = true
where not variants.activo
  and variants.id in (
    select distinct on (primary_variant.producto_id) primary_variant.id
    from public.producto_variantes primary_variant
    join public.productos products on products.id = primary_variant.producto_id
    where products.activo
    order by primary_variant.producto_id, primary_variant.orden, primary_variant.id
  );

comment on function public.product_activation_error(bigint) is
  'Centraliza el primer requisito faltante para publicar un producto.';
comment on function public.product_variant_activation_error(bigint, bigint, boolean) is
  'Centraliza el primer requisito faltante para activar una variante.';
comment on function public.set_product_commercial_state_atomic(bigint, boolean, uuid) is
  'Cambia el estado del producto; al desactivarlo apaga todas sus variantes sin borrar configuración.';

revoke all on function public.product_activation_error(bigint)
  from public, anon, authenticated;
revoke all on function public.assert_product_can_activate(bigint)
  from public, anon, authenticated;
revoke all on function public.product_variant_activation_error(bigint, bigint, boolean)
  from public, anon, authenticated;
revoke all on function public.assert_product_variant_can_activate(bigint, bigint, boolean)
  from public, anon, authenticated;
revoke all on function public.sync_product_variant_commercial_state()
  from public, anon, authenticated;
revoke all on function public.validate_product_commercial_state()
  from public, anon, authenticated;
revoke all on function public.validate_variant_commercial_state()
  from public, anon, authenticated;
revoke all on function public.validate_variant_allocation_commercial_state()
  from public, anon, authenticated;
revoke all on function public.validate_product_specification_commercial_state()
  from public, anon, authenticated;
