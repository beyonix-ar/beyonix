alter table public.reviews
  add column if not exists product_id bigint references public.productos(id) on delete set null;

alter table public.reviews
  drop constraint if exists reviews_one_per_order;

create unique index if not exists reviews_one_per_order_product_idx
  on public.reviews (user_id, order_id, product_id) nulls not distinct;

create index if not exists reviews_product_id_idx
  on public.reviews (product_id);
