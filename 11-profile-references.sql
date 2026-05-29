alter table public.profiles
add column if not exists referencias text;

notify pgrst, 'reload schema';