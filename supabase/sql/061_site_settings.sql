create table if not exists public.site_settings (
  key text primary key,
  value jsonb not null,
  description text not null default '',
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

insert into public.site_settings (key, value, description)
values
  (
    'shipping',
    jsonb_build_object(
      'defaultShippingCost', 15000,
      'freeShippingMinAmount', 75000,
      'shippingBonusMax', 12000,
      'freeShippingMode', 'full'
    ),
    'Configuracion de costos y bonificacion de envio.'
  )
on conflict (key) do nothing;

alter table public.site_settings enable row level security;

drop policy if exists "Anyone can read site settings"
  on public.site_settings;
create policy "Anyone can read site settings"
on public.site_settings
for select
to anon, authenticated
using (true);

drop policy if exists "Admins can manage site settings"
  on public.site_settings;
create policy "Admins can manage site settings"
on public.site_settings
for all
to authenticated
using (public.current_user_role() in ('admin', 'super_admin'))
with check (public.current_user_role() in ('admin', 'super_admin'));

revoke all on public.site_settings from anon, authenticated;
grant select on public.site_settings to anon, authenticated;
grant insert, update, delete on public.site_settings to authenticated;
