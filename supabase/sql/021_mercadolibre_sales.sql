create table if not exists public.mercadolibre_sales (
  id uuid primary key default gen_random_uuid(),
  sale_date timestamptz,
  operation_id text,
  order_id text,
  product_name text not null,
  sku text,
  quantity integer not null default 1 check (quantity > 0),
  gross_amount numeric(12, 2) not null default 0,
  fee_amount numeric(12, 2),
  shipping_amount numeric(12, 2),
  net_amount numeric(12, 2),
  source_file_name text,
  imported_by uuid references auth.users(id) on delete set null,
  imported_at timestamptz not null default now(),
  raw_data jsonb not null default '{}'::jsonb
);

create index if not exists mercadolibre_sales_sale_date_idx
  on public.mercadolibre_sales (sale_date desc);

create index if not exists mercadolibre_sales_imported_at_idx
  on public.mercadolibre_sales (imported_at desc);

create index if not exists mercadolibre_sales_sku_idx
  on public.mercadolibre_sales (sku);

alter table public.mercadolibre_sales enable row level security;

drop policy if exists "Admins can read MercadoLibre sales" on public.mercadolibre_sales;
create policy "Admins can read MercadoLibre sales"
on public.mercadolibre_sales
for select
to authenticated
using (public.current_user_role() in ('admin', 'super_admin'));

drop policy if exists "Admins can insert MercadoLibre sales" on public.mercadolibre_sales;
create policy "Admins can insert MercadoLibre sales"
on public.mercadolibre_sales
for insert
to authenticated
with check (public.current_user_role() in ('admin', 'super_admin'));

drop policy if exists "Super admins can delete MercadoLibre sales" on public.mercadolibre_sales;
create policy "Super admins can delete MercadoLibre sales"
on public.mercadolibre_sales
for delete
to authenticated
using (public.current_user_role() = 'super_admin');
