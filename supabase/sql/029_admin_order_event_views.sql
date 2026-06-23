create table if not exists public.admin_order_event_views (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null references auth.users(id) on delete cascade,
  order_id bigint not null references public.ordenes(id) on delete cascade,
  event_type text not null,
  event_at timestamptz not null,
  seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (admin_id, order_id, event_type)
);

create index if not exists admin_order_event_views_lookup_idx
  on public.admin_order_event_views (admin_id, event_type, order_id);

alter table public.admin_order_event_views enable row level security;

drop policy if exists "Admins can read own order event views"
  on public.admin_order_event_views;
create policy "Admins can read own order event views"
on public.admin_order_event_views
for select
to authenticated
using (admin_id = auth.uid());

drop policy if exists "Admins can insert own order event views"
  on public.admin_order_event_views;
create policy "Admins can insert own order event views"
on public.admin_order_event_views
for insert
to authenticated
with check (admin_id = auth.uid());

drop policy if exists "Admins can update own order event views"
  on public.admin_order_event_views;
create policy "Admins can update own order event views"
on public.admin_order_event_views
for update
to authenticated
using (admin_id = auth.uid())
with check (admin_id = auth.uid());

grant select, insert, update on public.admin_order_event_views to authenticated;

do $$
begin
  alter publication supabase_realtime add table public.admin_order_event_views;
exception
  when duplicate_object then null;
end $$;
