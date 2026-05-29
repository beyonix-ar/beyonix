create or replace function public.get_profile_email_by_username(username_input text)
returns text
language sql
security definer
set search_path = public
stable
as $$
  select email
  from public.profiles
  where lower(username) = lower(trim(username_input))
  limit 1;
$$;

grant execute on function public.get_profile_email_by_username(text) to anon;
grant execute on function public.get_profile_email_by_username(text) to authenticated;
