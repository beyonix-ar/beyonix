-- Datos logísticos opcionales para productos y variantes.
-- Cada valor de variante sobrescribe individualmente al del producto.

alter table public.productos
  add column if not exists peso_empaquetado_kg numeric(10, 3),
  add column if not exists alto_paquete_cm numeric(10, 2),
  add column if not exists ancho_paquete_cm numeric(10, 2),
  add column if not exists largo_paquete_cm numeric(10, 2);

alter table public.producto_variantes
  add column if not exists peso_empaquetado_kg numeric(10, 3),
  add column if not exists alto_paquete_cm numeric(10, 2),
  add column if not exists ancho_paquete_cm numeric(10, 2),
  add column if not exists largo_paquete_cm numeric(10, 2);

alter table public.productos
  drop constraint if exists productos_peso_empaquetado_kg_check,
  drop constraint if exists productos_alto_paquete_cm_check,
  drop constraint if exists productos_ancho_paquete_cm_check,
  drop constraint if exists productos_largo_paquete_cm_check,
  add constraint productos_peso_empaquetado_kg_check check (
    peso_empaquetado_kg is null or (
      peso_empaquetado_kg <> 'NaN'::numeric
      and peso_empaquetado_kg > 0
      and peso_empaquetado_kg <= 10000
    )
  ),
  add constraint productos_alto_paquete_cm_check check (
    alto_paquete_cm is null or (
      alto_paquete_cm <> 'NaN'::numeric
      and alto_paquete_cm > 0
      and alto_paquete_cm <= 1000
    )
  ),
  add constraint productos_ancho_paquete_cm_check check (
    ancho_paquete_cm is null or (
      ancho_paquete_cm <> 'NaN'::numeric
      and ancho_paquete_cm > 0
      and ancho_paquete_cm <= 1000
    )
  ),
  add constraint productos_largo_paquete_cm_check check (
    largo_paquete_cm is null or (
      largo_paquete_cm <> 'NaN'::numeric
      and largo_paquete_cm > 0
      and largo_paquete_cm <= 1000
    )
  );

alter table public.producto_variantes
  drop constraint if exists producto_variantes_peso_empaquetado_kg_check,
  drop constraint if exists producto_variantes_alto_paquete_cm_check,
  drop constraint if exists producto_variantes_ancho_paquete_cm_check,
  drop constraint if exists producto_variantes_largo_paquete_cm_check,
  add constraint producto_variantes_peso_empaquetado_kg_check check (
    peso_empaquetado_kg is null or (
      peso_empaquetado_kg <> 'NaN'::numeric
      and peso_empaquetado_kg > 0
      and peso_empaquetado_kg <= 10000
    )
  ),
  add constraint producto_variantes_alto_paquete_cm_check check (
    alto_paquete_cm is null or (
      alto_paquete_cm <> 'NaN'::numeric
      and alto_paquete_cm > 0
      and alto_paquete_cm <= 1000
    )
  ),
  add constraint producto_variantes_ancho_paquete_cm_check check (
    ancho_paquete_cm is null or (
      ancho_paquete_cm <> 'NaN'::numeric
      and ancho_paquete_cm > 0
      and ancho_paquete_cm <= 1000
    )
  ),
  add constraint producto_variantes_largo_paquete_cm_check check (
    largo_paquete_cm is null or (
      largo_paquete_cm <> 'NaN'::numeric
      and largo_paquete_cm > 0
      and largo_paquete_cm <= 1000
    )
  );

comment on column public.productos.peso_empaquetado_kg is
  'Peso en kg del paquete final listo para despachar.';
comment on column public.productos.alto_paquete_cm is
  'Alto en cm del paquete final listo para despachar.';
comment on column public.productos.ancho_paquete_cm is
  'Ancho en cm del paquete final listo para despachar.';
comment on column public.productos.largo_paquete_cm is
  'Largo en cm del paquete final listo para despachar.';
comment on column public.producto_variantes.peso_empaquetado_kg is
  'Sobrescritura opcional del peso logístico del producto.';
comment on column public.producto_variantes.alto_paquete_cm is
  'Sobrescritura opcional del alto logístico del producto.';
comment on column public.producto_variantes.ancho_paquete_cm is
  'Sobrescritura opcional del ancho logístico del producto.';
comment on column public.producto_variantes.largo_paquete_cm is
  'Sobrescritura opcional del largo logístico del producto.';

create or replace function public.create_product_variant_with_allocation_v2(
  p_product_id bigint,
  p_name text,
  p_sku text,
  p_color_hex text,
  p_images jsonb,
  p_quantity integer,
  p_actor_id uuid,
  p_peso_empaquetado_kg numeric,
  p_alto_paquete_cm numeric,
  p_ancho_paquete_cm numeric,
  p_largo_paquete_cm numeric
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
    p_product_id,
    p_name,
    p_sku,
    p_color_hex,
    p_images,
    p_quantity,
    p_actor_id
  );

  update public.producto_variantes
  set peso_empaquetado_kg = p_peso_empaquetado_kg,
      alto_paquete_cm = p_alto_paquete_cm,
      ancho_paquete_cm = p_ancho_paquete_cm,
      largo_paquete_cm = p_largo_paquete_cm
  where id = v_variant.id
  returning * into v_variant;

  return v_variant;
end;
$$;

revoke all on function public.create_product_variant_with_allocation_v2(
  bigint, text, text, text, jsonb, integer, uuid, numeric, numeric, numeric, numeric
) from public, anon, authenticated;
grant execute on function public.create_product_variant_with_allocation_v2(
  bigint, text, text, text, jsonb, integer, uuid, numeric, numeric, numeric, numeric
) to service_role;

create or replace function public.update_product_variant_with_allocation_v2(
  p_product_id bigint,
  p_variant_id bigint,
  p_name text,
  p_sku text,
  p_color_hex text,
  p_images jsonb,
  p_quantity integer,
  p_actor_id uuid,
  p_peso_empaquetado_kg numeric,
  p_alto_paquete_cm numeric,
  p_ancho_paquete_cm numeric,
  p_largo_paquete_cm numeric
)
returns public.producto_variantes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_variant public.producto_variantes%rowtype;
begin
  v_variant := public.update_product_variant_with_allocation(
    p_product_id,
    p_variant_id,
    p_name,
    p_sku,
    p_color_hex,
    p_images,
    p_quantity,
    p_actor_id
  );

  update public.producto_variantes
  set peso_empaquetado_kg = p_peso_empaquetado_kg,
      alto_paquete_cm = p_alto_paquete_cm,
      ancho_paquete_cm = p_ancho_paquete_cm,
      largo_paquete_cm = p_largo_paquete_cm
  where id = v_variant.id
  returning * into v_variant;

  return v_variant;
end;
$$;

revoke all on function public.update_product_variant_with_allocation_v2(
  bigint, bigint, text, text, text, jsonb, integer, uuid, numeric, numeric, numeric, numeric
) from public, anon, authenticated;
grant execute on function public.update_product_variant_with_allocation_v2(
  bigint, bigint, text, text, text, jsonb, integer, uuid, numeric, numeric, numeric, numeric
) to service_role;

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
begin
  v_product := public.create_producto_completo(
    p_producto,
    p_imagenes,
    p_variantes,
    p_especificaciones
  );

  update public.productos
  set peso_empaquetado_kg = nullif(p_producto ->> 'peso_empaquetado_kg', '')::numeric,
      alto_paquete_cm = nullif(p_producto ->> 'alto_paquete_cm', '')::numeric,
      ancho_paquete_cm = nullif(p_producto ->> 'ancho_paquete_cm', '')::numeric,
      largo_paquete_cm = nullif(p_producto ->> 'largo_paquete_cm', '')::numeric
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
