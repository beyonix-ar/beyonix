-- "Mismo precio en contado y cuotas" por producto.
--
-- productos.cuotas_sin_recargo = true => el precio financiado de ese producto
-- es igual al de contado (sin gross-up por el costo de Mercado Pago). Default
-- false: todos los productos existentes conservan la fórmula con recargo.
-- La regla es del PRODUCTO y la heredan todas sus variantes y unidades
-- condicionadas (el precio de cada una sigue siendo el suyo; sólo cambia si
-- se le suma o no el recargo por financiación). El precio financiado nunca se
-- persiste: se deriva server-side (lib/pricing/financed-pricing.ts) y la
-- regla usada queda en ordenes.pricing_snapshot de cada pedido.
--
-- Se redefinen las dos vías de escritura de la ficha de Productos para que
-- persistan el flag:
-- - create_producto_completo_v2 (alta desde la ficha): mismo cuerpo que
--   20260817090000 + cuotas_sin_recargo en el UPDATE posterior al alta.
-- - update_product_catalog_atomic (edición, vía
--   update_product_commercial_configuration[_with_pricing]_atomic): mismo
--   cuerpo que 20260827200001 + cuotas_sin_recargo. Si el payload no trae la
--   clave se conserva el valor actual (nunca se apaga por omisión).

alter table public.productos
  add column if not exists cuotas_sin_recargo boolean not null default false;

comment on column public.productos.cuotas_sin_recargo is
  'Mismo precio en contado y cuotas: el precio financiado del producto (y de sus variantes) es igual al de contado. Default false = precio financiado con recargo.';

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

  if v_peso is null or v_peso <= 0
     or v_alto is null or v_alto <= 0
     or v_ancho is null or v_ancho <= 0
     or v_largo is null or v_largo <= 0 then
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

revoke all on function public.create_producto_completo_v2(
  jsonb, jsonb, jsonb, jsonb
) from public, anon;
grant execute on function public.create_producto_completo_v2(
  jsonb, jsonb, jsonb, jsonb
) to authenticated, service_role;

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
      promo_original_cuotas_2_habilitadas = nullif(
        p_catalog ->> 'promo_original_cuotas_2_habilitadas',
        ''
      )::boolean,
      promo_original_cuotas_3_habilitadas = nullif(
        p_catalog ->> 'promo_original_cuotas_3_habilitadas',
        ''
      )::boolean,
      promo_original_cuotas_6_habilitadas = nullif(
        p_catalog ->> 'promo_original_cuotas_6_habilitadas',
        ''
      )::boolean,
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
