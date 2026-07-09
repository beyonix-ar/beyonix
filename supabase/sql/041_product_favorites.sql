create table if not exists public.product_favorites (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  product_id bigint not null references public.productos(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (user_id, product_id)
);

create index if not exists product_favorites_user_created_idx
  on public.product_favorites (user_id, created_at desc);

create index if not exists product_favorites_product_idx
  on public.product_favorites (product_id);

alter table public.product_favorites enable row level security;

drop policy if exists "Customers can read own favorites"
  on public.product_favorites;
create policy "Customers can read own favorites"
on public.product_favorites
for select
to authenticated
using (user_id = auth.uid());

drop policy if exists "Customers can create own favorites"
  on public.product_favorites;
create policy "Customers can create own favorites"
on public.product_favorites
for insert
to authenticated
with check (user_id = auth.uid());

drop policy if exists "Customers can delete own favorites"
  on public.product_favorites;
create policy "Customers can delete own favorites"
on public.product_favorites
for delete
to authenticated
using (user_id = auth.uid());

revoke all on public.product_favorites from anon, authenticated;
grant select, insert, delete on public.product_favorites to authenticated;
