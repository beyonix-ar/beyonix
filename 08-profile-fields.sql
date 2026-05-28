alter table public.profiles
add column if not exists username text;

alter table public.profiles
add column if not exists telefono text;

alter table public.profiles
add column if not exists direccion text;

alter table public.profiles
add column if not exists codigo_postal text;

alter table public.profiles
add column if not exists provincia text;

create unique index if not exists profiles_username_unique
on public.profiles (lower(username))
where username is not null;

notify pgrst, 'reload schema';
