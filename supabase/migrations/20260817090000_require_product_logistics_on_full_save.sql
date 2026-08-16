-- Peso y dimensiones son obligatorios al crear un producto desde la ficha
-- completa (Productos → Crear producto). Se valida únicamente dentro de
-- create_producto_completo_v2, el RPC que usa esa pantalla: no se toca la
-- función de Compras que crea un producto base sin publicar
-- (ensure_cost_catalog_product), que sigue sin requerir estos datos, ni el
-- constraint de la tabla (sigue permitiendo NULL para esa vía y para las
-- sobrescrituras opcionales por variante).

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
      largo_paquete_cm = v_largo
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

comment on function public.create_producto_completo_v2(jsonb, jsonb, jsonb, jsonb) is
  'Crea el producto completo desde la ficha de Productos; peso y dimensiones son obligatorios en esta vía únicamente.';
