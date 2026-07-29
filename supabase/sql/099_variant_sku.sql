-- SKU comercial independiente para cada variante de un producto.

alter table public.producto_variantes
  add column if not exists sku text;

update public.producto_variantes
set sku = null
where sku is not null
  and btrim(sku) = '';

update public.productos
set sku = null
where sku is not null
  and btrim(sku) = '';

create index if not exists producto_variantes_sku_search_idx
  on public.producto_variantes (lower(sku))
  where sku is not null;

comment on column public.producto_variantes.sku is
  'SKU comercial opcional y específico de la variante.';
