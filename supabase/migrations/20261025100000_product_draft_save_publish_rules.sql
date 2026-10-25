-- Guardar ≠ publicar (Admin > Productos, 25/10/2026).
--
-- 1. Borrador: un producto INACTIVO se guarda aunque falten precio, categoría,
--    descripción, logística, imágenes o variantes activas. Lo cargado se sigue
--    validando por formato/rango (CHECK de logística, precio >= 0).
--    create_producto_completo_v2 exigía peso y medidas siempre; ahora sólo si
--    el alta es activa (update_product_catalog_atomic ya lo hacía así).
-- 2. Publicar: la transición INACTIVO -> ACTIVO exige, además de lo actual,
--    al menos una variante activa y vendible (20261012120000 había quitado ese
--    chequeo al independizar los estados). Se evalúa en el trigger diferido
--    (al COMMIT, después de que el mismo guardado active sus variantes) y, con
--    mensaje inmediato, en set_product_commercial_state_atomic.
-- 3. Descripción enriquecida: "<p><br></p>", "<div></div>", "&nbsp;" o sólo
--    espacios no cuentan como descripción para publicar (mismo criterio que
--    richDescriptionToPlainText en el editor). Ningún producto activo actual
--    queda afectado (verificado en solo lectura antes de esta migración).
-- 4. Stock 0 en un producto ya publicado: guardar la ficha de un producto o de
--    una variante YA activos no vuelve a exigir los requisitos de activación
--    (stock > 0 y código de barra). Antes, editar un producto publicado que se
--    había quedado sin stock fallaba con "necesita stock asignado". Los
--    triggers diferidos siguen validando las invariantes sin stock.
--
-- Sin cambios de datos. Idempotente (create or replace).

begin;

-- Texto visible de una descripción enriquecida (ya saneada por la allowlist).
create or replace function public.rich_description_has_visible_text(p_html text)
returns boolean
language sql
immutable
set search_path = public
as $$
  select nullif(
    btrim(
      regexp_replace(
        regexp_replace(
          regexp_replace(coalesce(p_html, ''), '<[^>]*>', ' ', 'g'),
          '&(nbsp|#160|#xa0);',
          ' ',
          'gi'
        ),
        '[[:space:]' || chr(160) || chr(8203) || ']+',
        ' ',
        'g'
      )
    ),
    ''
  ) is not null
$$;

-- Al menos una variante activa que hoy se podría vender. p_require_stock=true
-- en la publicación: exige también su código de barra y stock asignado.
create or replace function public.product_has_sellable_active_variant(
  p_product_id bigint,
  p_require_stock boolean
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.producto_variantes variants
    where variants.producto_id = p_product_id
      and variants.activo
      and public.product_variant_listing_error(
        p_product_id,
        variants.id,
        false,
        p_require_stock
      ) is null
  )
$$;

create or replace function public.product_listing_error(
  p_product_id bigint,
  p_require_stock boolean
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
  if not public.rich_description_has_visible_text(v_product.descripcion) then
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

  return public.product_variant_listing_error(
    p_product_id,
    v_primary_variant_id,
    true,
    p_require_stock
  );
end;
$$;

-- Deferred: el stock y la variante vendible sólo se exigen si ESTE evento
-- activó el producto (alta activa o transición inactivo -> activo).
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
    if v_activating
       and not public.product_has_sellable_active_variant(new.id, true) then
      raise exception 'Activá al menos una variante vendible antes de publicar el producto.';
    end if;
  end if;
  return null;
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
  if p_active and not coalesce(v_product.activo, false) then
    perform public.assert_product_can_activate(p_product_id);
    if not public.product_has_sellable_active_variant(p_product_id, true) then
      raise exception 'Activá al menos una variante vendible antes de publicar el producto.';
    end if;
  end if;

  perform set_config('beyonix.actor_id', p_actor_id::text, true);
  update public.productos
  set activo = p_active
  where id = p_product_id
  returning * into v_product;

  return v_product;
end;
$$;

-- Misma función que 20261015130000 salvo la última validación: los
-- requisitos de ACTIVACIÓN (stock, código) sólo se exigen al pasar de
-- inactivo a activo; un producto ya publicado que se quedó sin stock se
-- sigue pudiendo editar.
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
  v_was_active boolean;
  v_primary_variant_id bigint;
  v_name text := nullif(btrim(coalesce(p_catalog ->> 'nombre', '')), '');
  v_slug text := nullif(btrim(coalesce(p_catalog ->> 'slug', '')), '');
  v_price numeric := nullif(p_catalog ->> 'precio', '')::numeric;
  v_active boolean := coalesce((p_catalog ->> 'activo')::boolean, false);
  v_category_id bigint := nullif(p_catalog ->> 'categoria_id', '')::bigint;
  v_legacy_cuotas_sin_interes boolean := coalesce((p_catalog ->> 'cuotas_sin_interes')::boolean, false);
  v_legacy_cuotas_maximas text := p_catalog ->> 'cuotas_maximas';
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
  v_was_active := coalesce(v_product.activo, false);

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
      cuotas_2_habilitadas = coalesce(
        (p_catalog ->> 'cuotas_2_habilitadas')::boolean,
        false
      ),
      cuotas_3_habilitadas = coalesce(
        (p_catalog ->> 'cuotas_3_habilitadas')::boolean,
        v_legacy_cuotas_sin_interes and v_legacy_cuotas_maximas = '3'
      ),
      cuotas_6_habilitadas = coalesce(
        (p_catalog ->> 'cuotas_6_habilitadas')::boolean,
        v_legacy_cuotas_sin_interes and v_legacy_cuotas_maximas = '6'
      ),
      cuotas_sin_recargo = coalesce(
        nullif(p_catalog ->> 'cuotas_sin_recargo', '')::boolean,
        products.cuotas_sin_recargo
      ),
      -- El bloqueo de una promoción activa (eventos masivos) lo administra
      -- el evento: si el editor no manda estas claves, se conservan.
      promo_event_id = case when p_catalog ? 'promo_event_id'
        then nullif(p_catalog ->> 'promo_event_id', '')::uuid
        else products.promo_event_id end,
      promo_original_precio = case when p_catalog ? 'promo_original_precio'
        then nullif(p_catalog ->> 'promo_original_precio', '')::numeric
        else products.promo_original_precio end,
      promo_original_precio_anterior = case when p_catalog ? 'promo_original_precio_anterior'
        then nullif(p_catalog ->> 'promo_original_precio_anterior', '')::numeric
        else products.promo_original_precio_anterior end,
      promo_original_descuento = case when p_catalog ? 'promo_original_descuento'
        then nullif(p_catalog ->> 'promo_original_descuento', '')::numeric
        else products.promo_original_descuento end,
      promo_original_cuotas_2_habilitadas = case when p_catalog ? 'promo_original_cuotas_2_habilitadas'
        then nullif(p_catalog ->> 'promo_original_cuotas_2_habilitadas', '')::boolean
        else products.promo_original_cuotas_2_habilitadas end,
      promo_original_cuotas_3_habilitadas = case when p_catalog ? 'promo_original_cuotas_3_habilitadas'
        then nullif(p_catalog ->> 'promo_original_cuotas_3_habilitadas', '')::boolean
        else products.promo_original_cuotas_3_habilitadas end,
      promo_original_cuotas_6_habilitadas = case when p_catalog ? 'promo_original_cuotas_6_habilitadas'
        then nullif(p_catalog ->> 'promo_original_cuotas_6_habilitadas', '')::boolean
        else products.promo_original_cuotas_6_habilitadas end,
      categoria_id = v_category_id,
      destacado = coalesce((p_catalog ->> 'destacado')::boolean, false),
      activo = v_active,
      peso_empaquetado_kg = nullif(p_catalog ->> 'peso_empaquetado_kg', '')::numeric,
      alto_paquete_cm = nullif(p_catalog ->> 'alto_paquete_cm', '')::numeric,
      ancho_paquete_cm = nullif(p_catalog ->> 'ancho_paquete_cm', '')::numeric,
      largo_paquete_cm = nullif(p_catalog ->> 'largo_paquete_cm', '')::numeric
  where products.id = p_product_id
  returning * into v_product;

  if v_active and not v_was_active then
    perform public.assert_product_can_activate(p_product_id);
  end if;

  return v_product;
end;
$$;

-- Misma función que 20261012120000 salvo que los requisitos de ACTIVACIÓN se
-- exigen sólo a lo que cambia de inactivo a activo (producto o variante).
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
  v_product_was_active boolean;
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
  v_product_was_active := coalesce(v_product.activo, false);

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
      join public.producto_variantes variants
        on variants.id = requested.id
       and variants.producto_id = p_product_id
      where requested.active
        and not coalesce(variants.activo, false)
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

  if v_product_active and not v_product_was_active then
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

-- Misma función que 20260929100000 salvo la logística: obligatoria sólo si el
-- alta ya es activa. En un borrador lo cargado se valida igual por los CHECK
-- de productos (> 0 y dentro de los límites).
create or replace function public.create_producto_completo_v2(
  p_producto jsonb,
  p_imagenes jsonb default '[]'::jsonb,
  p_variantes jsonb default '[]'::jsonb,
  p_especificaciones jsonb default '[]'::jsonb
)
returns public.productos
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product public.productos%rowtype;
  v_variant jsonb;
  v_variant_id bigint;
  v_index integer := 0;
  v_peso numeric;
  v_alto numeric;
  v_ancho numeric;
  v_largo numeric;
begin
  v_peso := nullif(p_producto ->> 'peso_empaquetado_kg', '')::numeric;
  v_alto := nullif(p_producto ->> 'alto_paquete_cm', '')::numeric;
  v_ancho := nullif(p_producto ->> 'ancho_paquete_cm', '')::numeric;
  v_largo := nullif(p_producto ->> 'largo_paquete_cm', '')::numeric;

  if coalesce((p_producto ->> 'activo')::boolean, false) and (
    v_peso is null or v_peso <= 0
    or v_alto is null or v_alto <= 0
    or v_ancho is null or v_ancho <= 0
    or v_largo is null or v_largo <= 0
  ) then
    raise exception
      'El peso y las dimensiones del producto (alto, ancho y largo) son obligatorios y deben ser mayores que 0.';
  end if;

  v_product := public.create_producto_completo(
    p_producto,
    p_imagenes,
    p_variantes,
    p_especificaciones
  );

  update public.productos
  set peso_empaquetado_kg = v_peso,
      alto_paquete_cm = v_alto,
      ancho_paquete_cm = v_ancho,
      largo_paquete_cm = v_largo,
      cuotas_sin_recargo = coalesce(
        nullif(p_producto ->> 'cuotas_sin_recargo', '')::boolean,
        false
      )
  where id = v_product.id;

  for v_variant in
    select value
    from jsonb_array_elements(coalesce(p_variantes, '[]'::jsonb))
  loop
    select variants.id
    into v_variant_id
    from public.producto_variantes variants
    where variants.producto_id = v_product.id
    order by variants.id
    offset v_index
    limit 1;

    if v_variant_id is null then
      raise exception 'No se pudo verificar una variante recién creada.';
    end if;

    update public.producto_variantes
    set sku = nullif(left(btrim(coalesce(v_variant ->> 'sku', '')), 120), ''),
        peso_empaquetado_kg = nullif(v_variant ->> 'peso_empaquetado_kg', '')::numeric,
        alto_paquete_cm = nullif(v_variant ->> 'alto_paquete_cm', '')::numeric,
        ancho_paquete_cm = nullif(v_variant ->> 'ancho_paquete_cm', '')::numeric,
        largo_paquete_cm = nullif(v_variant ->> 'largo_paquete_cm', '')::numeric
    where id = v_variant_id;

    v_index := v_index + 1;
  end loop;

  if jsonb_array_length(coalesce(p_variantes, '[]'::jsonb)) = 0 then
    update public.productos
    set sku = nullif(left(btrim(coalesce(p_producto ->> 'sku', '')), 120), '')
    where id = v_product.id;
  end if;

  select * into v_product
  from public.productos
  where id = v_product.id;

  return v_product;
end;
$$;

revoke all on function public.rich_description_has_visible_text(text)
  from public, anon, authenticated;
revoke all on function public.product_has_sellable_active_variant(bigint, boolean)
  from public, anon, authenticated;
revoke all on function public.product_listing_error(bigint, boolean)
  from public, anon, authenticated;
revoke all on function public.validate_product_commercial_state()
  from public, anon, authenticated;
revoke all on function public.set_product_commercial_state_atomic(bigint, boolean, uuid)
  from public, anon, authenticated;
grant execute on function public.set_product_commercial_state_atomic(bigint, boolean, uuid)
  to service_role;
revoke all on function public.update_product_catalog_atomic(bigint, jsonb, text, uuid)
  from public, anon, authenticated;
grant execute on function public.update_product_catalog_atomic(bigint, jsonb, text, uuid)
  to service_role;
revoke all on function public.update_product_commercial_configuration_atomic(bigint, jsonb, text, jsonb, uuid)
  from public, anon, authenticated;
grant execute on function public.update_product_commercial_configuration_atomic(bigint, jsonb, text, jsonb, uuid)
  to service_role;
revoke all on function public.create_producto_completo_v2(jsonb, jsonb, jsonb, jsonb)
  from public, anon;
grant execute on function public.create_producto_completo_v2(jsonb, jsonb, jsonb, jsonb)
  to authenticated, service_role;

comment on function public.rich_description_has_visible_text(text) is
  'La descripción enriquecida tiene texto visible (marcado vacío, &nbsp; y espacios no cuentan).';
comment on function public.product_has_sellable_active_variant(bigint, boolean) is
  'Existe al menos una variante activa que cumple sus requisitos comerciales (con stock y código si p_require_stock).';
comment on function public.product_listing_error(bigint, boolean) is
  'Requisitos comerciales de un producto. p_require_stock=true sólo al activarlo: un producto activo que se agota por una venta sigue siendo válido (Sin stock).';

commit;
