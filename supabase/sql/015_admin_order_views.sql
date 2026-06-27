create table if not exists public.admin_order_views (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null references auth.users(id) on delete cascade,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(admin_id)
);

alter table public.admin_order_views enable row level security;

create or replace function public.set_admin_order_views_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_admin_order_views_updated_at
  on public.admin_order_views;

create trigger set_admin_order_views_updated_at
before update on public.admin_order_views
for each row
execute function public.set_admin_order_views_updated_at();

drop policy if exists "Admins can read own order view"
  on public.admin_order_views;

create policy "Admins can read own order view"
on public.admin_order_views
for select
to authenticated
using (
  admin_id = auth.uid()
  and exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and profiles.rol in ('admin', 'super_admin')
  )
);

drop policy if exists "Admins can insert own order view"
  on public.admin_order_views;

create policy "Admins can insert own order view"
on public.admin_order_views
for insert
to authenticated
with check (
  admin_id = auth.uid()
  and exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and profiles.rol in ('admin', 'super_admin')
  )
);

drop policy if exists "Admins can update own order view"
  on public.admin_order_views;

create policy "Admins can update own order view"
on public.admin_order_views
for update
to authenticated
using (
  admin_id = auth.uid()
  and exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and profiles.rol in ('admin', 'super_admin')
  )
)
with check (
  admin_id = auth.uid()
  and exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and profiles.rol in ('admin', 'super_admin')
  )
);
