create table if not exists public.admin_order_views (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null references auth.users(id) on delete cascade,
  last_seen_at timestamptz not null default '2000-01-01 00:00:00+00',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(admin_id)
);

alter table public.admin_order_views
  alter column last_seen_at
  set default '2000-01-01 00:00:00+00';

alter table public.admin_order_views enable row level security;

drop policy if exists "Admins can read own order view"
  on public.admin_order_views;
drop policy if exists "Admins can insert own order view"
  on public.admin_order_views;
drop policy if exists "Admins can update own order view"
  on public.admin_order_views;
drop policy if exists "Admins can read own order views"
  on public.admin_order_views;
drop policy if exists "Admins can insert own order views"
  on public.admin_order_views;
drop policy if exists "Admins can update own order views"
  on public.admin_order_views;

create policy "Admins can read own order views"
on public.admin_order_views
for select
to authenticated
using (admin_id = auth.uid());

create policy "Admins can insert own order views"
on public.admin_order_views
for insert
to authenticated
with check (admin_id = auth.uid());

create policy "Admins can update own order views"
on public.admin_order_views
for update
to authenticated
using (admin_id = auth.uid())
with check (admin_id = auth.uid());

alter table public.profiles enable row level security;

drop policy if exists "Users can read own profile"
  on public.profiles;
drop policy if exists "Users can insert own profile"
  on public.profiles;
drop policy if exists "Users can update own profile"
  on public.profiles;

create policy "Users can read own profile"
on public.profiles
for select
to authenticated
using (id = auth.uid());

create policy "Users can insert own profile"
on public.profiles
for insert
to authenticated
with check (id = auth.uid());

create policy "Users can update own profile"
on public.profiles
for update
to authenticated
using (id = auth.uid())
with check (id = auth.uid());

create or replace function public.sync_signup_profile(user_id_input uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (
    id,
    email,
    username,
    nombre,
    telefono,
    calle,
    numero,
    piso,
    departamento,
    localidad,
    codigo_postal,
    provincia,
    referencias
  )
  select
    users.id,
    users.email,
    nullif(users.raw_user_meta_data ->> 'username', ''),
    coalesce(users.raw_user_meta_data ->> 'nombre', ''),
    nullif(users.raw_user_meta_data ->> 'telefono', ''),
    nullif(users.raw_user_meta_data ->> 'calle', ''),
    nullif(users.raw_user_meta_data ->> 'numero', ''),
    nullif(users.raw_user_meta_data ->> 'piso', ''),
    nullif(users.raw_user_meta_data ->> 'departamento', ''),
    nullif(users.raw_user_meta_data ->> 'localidad', ''),
    nullif(users.raw_user_meta_data ->> 'codigo_postal', ''),
    nullif(users.raw_user_meta_data ->> 'provincia', ''),
    nullif(users.raw_user_meta_data ->> 'referencias', '')
  from auth.users
  where users.id = user_id_input
    and (
      auth.uid() = users.id
      or (
        auth.uid() is null
        and users.email_confirmed_at is null
        and users.created_at >= now() - interval '10 minutes'
      )
    )
  on conflict (id) do update
  set
    email = excluded.email,
    username = coalesce(excluded.username, profiles.username),
    nombre = coalesce(nullif(excluded.nombre, ''), profiles.nombre),
    telefono = coalesce(excluded.telefono, profiles.telefono),
    calle = coalesce(excluded.calle, profiles.calle),
    numero = coalesce(excluded.numero, profiles.numero),
    piso = coalesce(excluded.piso, profiles.piso),
    departamento = coalesce(excluded.departamento, profiles.departamento),
    localidad = coalesce(excluded.localidad, profiles.localidad),
    codigo_postal = coalesce(excluded.codigo_postal, profiles.codigo_postal),
    provincia = coalesce(excluded.provincia, profiles.provincia),
    referencias = coalesce(excluded.referencias, profiles.referencias);
end;
$$;

revoke all on function public.sync_signup_profile(uuid) from public;
grant execute on function public.sync_signup_profile(uuid) to anon, authenticated;
