alter table public.profiles
  add column if not exists email text,
  add column if not exists username text,
  add column if not exists nombre text,
  add column if not exists telefono text,
  add column if not exists calle text,
  add column if not exists numero text,
  add column if not exists piso text,
  add column if not exists departamento text,
  add column if not exists localidad text,
  add column if not exists codigo_postal text,
  add column if not exists provincia text,
  add column if not exists referencias text;

create or replace function public.sync_auth_user_profile()
returns trigger
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
  values (
    new.id,
    new.email,
    nullif(new.raw_user_meta_data ->> 'username', ''),
    coalesce(new.raw_user_meta_data ->> 'nombre', ''),
    nullif(new.raw_user_meta_data ->> 'telefono', ''),
    nullif(new.raw_user_meta_data ->> 'calle', ''),
    nullif(new.raw_user_meta_data ->> 'numero', ''),
    nullif(new.raw_user_meta_data ->> 'piso', ''),
    nullif(new.raw_user_meta_data ->> 'departamento', ''),
    nullif(new.raw_user_meta_data ->> 'localidad', ''),
    nullif(new.raw_user_meta_data ->> 'codigo_postal', ''),
    nullif(new.raw_user_meta_data ->> 'provincia', ''),
    nullif(new.raw_user_meta_data ->> 'referencias', '')
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

  return new;
end;
$$;

drop trigger if exists sync_auth_user_profile on auth.users;
drop trigger if exists zz_sync_auth_user_profile on auth.users;

create trigger zz_sync_auth_user_profile
after insert
on auth.users
for each row
execute function public.sync_auth_user_profile();

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
    and users.email_confirmed_at is null
    and users.created_at >= now() - interval '10 minutes'
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

create or replace function public.get_profile_email_by_username(
  username_input text
)
returns text
language sql
security definer
stable
set search_path = public
as $$
  select profiles.email
  from public.profiles
  where lower(profiles.username) = lower(trim(username_input))
  limit 1;
$$;

revoke all on function public.sync_signup_profile(uuid) from public;
grant execute on function public.sync_signup_profile(uuid) to anon, authenticated;

revoke all on function public.get_profile_email_by_username(text) from public;
grant execute on function public.get_profile_email_by_username(text) to anon, authenticated;

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
