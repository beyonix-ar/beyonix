alter table public.product_cost_entries
  add column if not exists sku text;

create index if not exists product_cost_entries_sku_idx
  on public.product_cost_entries (sku)
  where sku is not null;

comment on column public.product_cost_entries.sku is
  'SKU informado para la compra, incluso cuando el artículo no pertenece al catálogo.';
