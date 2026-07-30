-- Recupera el vínculo original de lotes condicionados históricos cuando la
-- importación no lo había persistido. Prioriza SKU inequívoco y, como respaldo,
-- el único color/variante existente en el producto.

with sku_matches as (
  select
    movements.id as movement_id,
    min(variants.id) as variant_id
  from public.inventory_return_movements movements
  join public.mercadolibre_sales sales
    on sales.id = movements.mercadolibre_sale_id
  join public.producto_variantes variants
    on variants.producto_id = movements.product_id
   and public.normalized_catalog_sku(variants.sku)
       = public.normalized_catalog_sku(sales.sku)
  where movements.discounted_quantity > 0
    and movements.variant_id is null
    and public.normalized_catalog_sku(sales.sku) is not null
  group by movements.id
  having count(*) = 1
)
update public.inventory_return_movements movements
set variant_id = matches.variant_id
from sku_matches matches
where matches.movement_id = movements.id;

with unique_variants as (
  select
    movements.id as movement_id,
    min(variants.id) as variant_id
  from public.inventory_return_movements movements
  join public.producto_variantes variants
    on variants.producto_id = movements.product_id
  where movements.discounted_quantity > 0
    and movements.variant_id is null
  group by movements.id
  having count(*) = 1
)
update public.inventory_return_movements movements
set variant_id = matches.variant_id
from unique_variants matches
where matches.movement_id = movements.id;

update public.inventory_return_movements movements
set conditioned_name = variants.nombre || ' · Con descuento',
    conditioned_sku =
      left(
        coalesce(nullif(btrim(variants.sku), ''), 'COND'),
        96
      )
      || '-DESC-'
      || upper(substr(replace(movements.id::text, '-', ''), 1, 8)),
    conditioned_color_hex = variants.color_hex,
    conditioned_images = case
      when jsonb_array_length(coalesce(variants.imagenes, '[]'::jsonb)) > 0
        then variants.imagenes
      else movements.conditioned_images
    end
from public.producto_variantes variants
where variants.id = movements.variant_id
  and movements.discounted_quantity > 0
  and (
    movements.conditioned_sku like 'COND-DESC-%'
    or movements.conditioned_name is null
    or movements.conditioned_color_hex is null
  );

comment on column public.inventory_return_movements.variant_id is
  'Variante normal de origen; se conserva como vínculo y no comparte stock con la oferta condicionada.';
