alter table public.product_cost_entries
  add column if not exists article_name text;

alter table public.product_cost_entries
  alter column product_id drop not null;

alter table public.product_cost_entries
  drop constraint if exists product_cost_entries_article_required;

alter table public.product_cost_entries
  add constraint product_cost_entries_article_required check (
    product_id is not null
    or nullif(btrim(article_name), '') is not null
  );

alter table public.product_cost_entries
  drop constraint if exists product_cost_entries_variant_requires_product;

alter table public.product_cost_entries
  add constraint product_cost_entries_variant_requires_product check (
    variant_id is null or product_id is not null
  );

comment on column public.product_cost_entries.article_name is
  'Nombre libre del artículo cuando la compra no está vinculada al catálogo.';
