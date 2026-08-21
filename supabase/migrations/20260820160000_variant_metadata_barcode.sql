-- Permite editar el código de barra de una variante existente a través de
-- update_product_variant_metadata_atomic, igual que sku/color_hex/nombre.
-- La unicidad la sigue garantizando catalog_barcode_registry (trigger
-- sync_variant_catalog_barcode_registry, 20260820120000).

create or replace function public.update_product_variant_metadata_atomic(
  p_product_id bigint,
  p_variant_id bigint,
  p_metadata jsonb,
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
    raise exception 'No tenés permisos para actualizar la variante.';
  end if;
  if jsonb_typeof(coalesce(p_metadata, 'null'::jsonb)) <> 'object' then
    raise exception 'Los datos de la variante no son válidos.';
  end if;

  perform pg_advisory_xact_lock(93000, p_product_id::integer);
  perform set_config('beyonix.actor_id', p_actor_id::text, true);

  update public.producto_variantes variants
  set nombre = case when p_metadata ? 'nombre'
        then left(btrim(p_metadata ->> 'nombre'), 160) else variants.nombre end,
      sku = case when p_metadata ? 'sku'
        then nullif(left(btrim(coalesce(p_metadata ->> 'sku', '')), 120), '')
        else variants.sku end,
      color_hex = case when p_metadata ? 'color_hex'
        then upper(p_metadata ->> 'color_hex') else variants.color_hex end,
      codigo_barra = case when p_metadata ? 'codigo_barra'
        then nullif(left(btrim(coalesce(p_metadata ->> 'codigo_barra', '')), 64), '')
        else variants.codigo_barra end,
      imagenes = case when p_metadata ? 'imagenes'
        then p_metadata -> 'imagenes' else variants.imagenes end,
      orden = case when p_metadata ? 'orden'
        then (p_metadata ->> 'orden')::integer else variants.orden end,
      peso_empaquetado_kg = case when p_metadata ? 'peso_empaquetado_kg'
        then nullif(p_metadata ->> 'peso_empaquetado_kg', '')::numeric
        else variants.peso_empaquetado_kg end,
      alto_paquete_cm = case when p_metadata ? 'alto_paquete_cm'
        then nullif(p_metadata ->> 'alto_paquete_cm', '')::numeric
        else variants.alto_paquete_cm end,
      ancho_paquete_cm = case when p_metadata ? 'ancho_paquete_cm'
        then nullif(p_metadata ->> 'ancho_paquete_cm', '')::numeric
        else variants.ancho_paquete_cm end,
      largo_paquete_cm = case when p_metadata ? 'largo_paquete_cm'
        then nullif(p_metadata ->> 'largo_paquete_cm', '')::numeric
        else variants.largo_paquete_cm end
  where variants.id = p_variant_id
    and variants.producto_id = p_product_id
  returning * into v_variant;

  if not found then
    raise exception 'La variante ya no existe.';
  end if;
  perform public.sync_product_primary_variant_image(p_product_id);
  return v_variant;
end;
$$;
