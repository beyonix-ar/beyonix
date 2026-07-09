create table if not exists public.site_banner_items (
  id uuid primary key default gen_random_uuid(),
  placement text not null default 'products' check (placement in ('products')),
  image_url text not null,
  alt_text text not null default '',
  active boolean not null default true,
  sort_order integer not null default 0,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.site_banner_items (
  placement,
  image_url,
  alt_text,
  active,
  sort_order,
  updated_by,
  updated_at
)
select
  'products',
  image_url,
  coalesce(nullif(alt_text, ''), 'Banner de productos BEYONIX'),
  active,
  0,
  updated_by,
  updated_at
from public.site_banners
where key = 'products_hero'
  and image_url is not null
  and image_url <> ''
  and not exists (
    select 1
    from public.site_banner_items
    where placement = 'products'
  );

create index if not exists site_banner_items_placement_active_order_idx
  on public.site_banner_items (placement, active, sort_order, created_at);

alter table public.site_banner_items enable row level security;

drop policy if exists "Anyone can read active banner items"
  on public.site_banner_items;
create policy "Anyone can read active banner items"
on public.site_banner_items
for select
to anon, authenticated
using (active = true);

drop policy if exists "Admins can manage banner items"
  on public.site_banner_items;
create policy "Admins can manage banner items"
on public.site_banner_items
for all
to authenticated
using (public.current_user_role() in ('admin', 'super_admin'))
with check (public.current_user_role() in ('admin', 'super_admin'));

revoke all on public.site_banner_items from anon, authenticated;
grant select on public.site_banner_items to anon, authenticated;
grant insert, update, delete on public.site_banner_items to authenticated;

insert into storage.buckets (id, name, public)
values ('site-banners', 'site-banners', true)
on conflict (id) do update set public = true;

drop policy if exists "Anyone can read site banner files"
  on storage.objects;
create policy "Anyone can read site banner files"
on storage.objects
for select
to anon, authenticated
using (bucket_id = 'site-banners');

drop policy if exists "Admins can upload site banner files"
  on storage.objects;
create policy "Admins can upload site banner files"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'site-banners'
  and public.current_user_role() in ('admin', 'super_admin')
);

drop policy if exists "Admins can update site banner files"
  on storage.objects;
create policy "Admins can update site banner files"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'site-banners'
  and public.current_user_role() in ('admin', 'super_admin')
)
with check (
  bucket_id = 'site-banners'
  and public.current_user_role() in ('admin', 'super_admin')
);

drop policy if exists "Admins can delete site banner files"
  on storage.objects;
create policy "Admins can delete site banner files"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'site-banners'
  and public.current_user_role() in ('admin', 'super_admin')
);
