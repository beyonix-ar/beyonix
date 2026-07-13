alter table public.profiles
  add column if not exists dni text;

alter table public.ordenes
  add column if not exists cliente_dni text;

