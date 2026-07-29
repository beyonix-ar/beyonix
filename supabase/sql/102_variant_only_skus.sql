-- Los productos con variantes no tienen un SKU general.
-- Cada SKU identifica exclusivamente una variante concreta.

update public.producto_variantes variants
set sku = products.sku
from public.productos products
where products.id = variants.producto_id
  and nullif(btrim(products.sku), '') is not null
  and nullif(btrim(variants.sku), '') is null
  and (
    select count(*)
    from public.producto_variantes siblings
    where siblings.producto_id = products.id
  ) = 1;

update public.productos products
set sku = null
where exists (
  select 1
  from public.producto_variantes variants
  where variants.producto_id = products.id
);

comment on column public.productos.sku is
  'SKU del producto cuando no posee variantes; con variantes, el SKU se guarda en producto_variantes.';
