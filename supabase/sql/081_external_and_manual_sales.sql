create table if not exists public.external_sales (
  id uuid primary key default gen_random_uuid(),
  sale_date date not null default current_date,
  product_id bigint references public.productos(id) on delete set null,
  product_name text not null,
  sku text,
  quantity integer not null default 1 check (quantity > 0),
  unit_price numeric(12, 2) not null default 0 check (unit_price >= 0),
  unit_cost numeric(12, 2) not null default 0 check (unit_cost >= 0),
  gross_amount numeric(12, 2) not null default 0 check (gross_amount >= 0),
  fee_type text not null default 'amount' check (fee_type in ('amount', 'percent')),
  fee_value numeric(12, 2) not null default 0 check (fee_value >= 0),
  fee_amount numeric(12, 2) not null default 0 check (fee_amount >= 0),
  shipping_amount numeric(12, 2) not null default 0 check (shipping_amount >= 0),
  other_expense_amount numeric(12, 2) not null default 0 check (other_expense_amount >= 0),
  net_amount numeric(12, 2) not null default 0,
  payment_method text,
  reference text,
  customer_name text,
  notes text,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists external_sales_sale_date_idx
  on public.external_sales (sale_date desc);

create index if not exists external_sales_product_id_idx
  on public.external_sales (product_id);

alter table public.external_sales enable row level security;

drop policy if exists "Admins can read external sales" on public.external_sales;
create policy "Admins can read external sales"
on public.external_sales for select to authenticated
using (public.current_user_role() in ('admin', 'super_admin'));

drop policy if exists "Admins can insert external sales" on public.external_sales;
create policy "Admins can insert external sales"
on public.external_sales for insert to authenticated
with check (public.current_user_role() in ('admin', 'super_admin'));

drop policy if exists "Admins can update external sales" on public.external_sales;
create policy "Admins can update external sales"
on public.external_sales for update to authenticated
using (public.current_user_role() in ('admin', 'super_admin'))
with check (public.current_user_role() in ('admin', 'super_admin'));

drop policy if exists "Admins can delete external sales" on public.external_sales;
create policy "Admins can delete external sales"
on public.external_sales for delete to authenticated
using (public.current_user_role() in ('admin', 'super_admin'));

alter table public.mercadolibre_sales
  add column if not exists product_id bigint references public.productos(id) on delete set null,
  add column if not exists unit_price numeric(12, 2),
  add column if not exists unit_cost numeric(12, 2) not null default 0,
  add column if not exists fee_type text not null default 'amount' check (fee_type in ('amount', 'percent')),
  add column if not exists fee_value numeric(12, 2) not null default 0,
  add column if not exists other_expense_amount numeric(12, 2) not null default 0,
  add column if not exists payment_method text,
  add column if not exists reference text,
  add column if not exists customer_name text,
  add column if not exists notes text,
  add column if not exists updated_by uuid references auth.users(id) on delete set null,
  add column if not exists updated_at timestamptz not null default now();

create or replace function public.set_sales_ledger_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists external_sales_updated_at on public.external_sales;
create trigger external_sales_updated_at
before update on public.external_sales
for each row execute function public.set_sales_ledger_updated_at();

drop trigger if exists mercadolibre_sales_updated_at on public.mercadolibre_sales;
create trigger mercadolibre_sales_updated_at
before update on public.mercadolibre_sales
for each row execute function public.set_sales_ledger_updated_at();

drop policy if exists "Admins can update MercadoLibre sales" on public.mercadolibre_sales;
create policy "Admins can update MercadoLibre sales"
on public.mercadolibre_sales for update to authenticated
using (public.current_user_role() in ('admin', 'super_admin'))
with check (public.current_user_role() in ('admin', 'super_admin'));

drop policy if exists "Super admins can delete MercadoLibre sales" on public.mercadolibre_sales;
drop policy if exists "Admins can delete MercadoLibre sales" on public.mercadolibre_sales;
create policy "Admins can delete MercadoLibre sales"
on public.mercadolibre_sales for delete to authenticated
using (public.current_user_role() in ('admin', 'super_admin'));

grant select, insert, update, delete on public.external_sales to authenticated;
grant select, insert, update, delete on public.mercadolibre_sales to authenticated;

comment on table public.external_sales is
  'Ventas manuales realizadas fuera de la tienda web y Mercado Libre.';
