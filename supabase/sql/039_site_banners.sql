create table if not exists public.site_banners (
  key text primary key,
  title text not null,
  image_url text,
  alt_text text not null default '',
  active boolean not null default true,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

insert into public.site_banners (key, title, image_url, alt_text, active)
values ('products_hero', 'Banner principal de productos', null, 'Banner de productos BEYONIX', true)
on conflict (key) do nothing;

alter table public.site_banners enable row level security;

drop policy if exists "Anyone can read active site banners"
  on public.site_banners;
create policy "Anyone can read active site banners"
on public.site_banners
for select
to anon, authenticated
using (active = true);

drop policy if exists "Admins can manage site banners"
  on public.site_banners;
create policy "Admins can manage site banners"
on public.site_banners
for all
to authenticated
using (public.current_user_role() in ('admin', 'super_admin'))
with check (public.current_user_role() in ('admin', 'super_admin'));

revoke all on public.site_banners from anon, authenticated;
grant select on public.site_banners to anon, authenticated;
grant insert, update, delete on public.site_banners to authenticated;
