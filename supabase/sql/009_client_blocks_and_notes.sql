alter table public.profiles
  add column if not exists client_risk_status text not null default 'normal',
  add column if not exists admin_note text,
  add column if not exists blocked_at timestamptz,
  add column if not exists blocked_reason text,
  add column if not exists blocked_by uuid references auth.users(id);

alter table public.profiles
  drop constraint if exists profiles_client_risk_status_check;

alter table public.profiles
  add constraint profiles_client_risk_status_check
  check (client_risk_status in ('normal', 'tedioso', 'complicado'));

create table if not exists public.blocked_client_identifiers (
  id bigserial primary key,
  identifier_type text not null,
  identifier_value text not null,
  reason text,
  source_profile_id uuid references public.profiles(id) on delete set null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  constraint blocked_client_identifiers_type_check
    check (identifier_type in ('email', 'username', 'phone')),
  constraint blocked_client_identifiers_unique
    unique (identifier_type, identifier_value)
);

alter table public.blocked_client_identifiers enable row level security;

drop policy if exists "Admins can read blocked client identifiers"
  on public.blocked_client_identifiers;

create policy "Admins can read blocked client identifiers"
  on public.blocked_client_identifiers
  for select
  using (
    exists (
      select 1
      from public.profiles
      where id = auth.uid()
        and rol in ('admin', 'super_admin')
    )
  );

create or replace function public.normalize_block_identifier(
  identifier_type_input text,
  identifier_value_input text
)
returns text
language sql
immutable
as $$
  select case
    when identifier_type_input = 'phone'
      then regexp_replace(lower(trim(coalesce(identifier_value_input, ''))), '\D', '', 'g')
    else lower(trim(coalesce(identifier_value_input, '')))
  end
$$;

create or replace function public.is_client_registration_blocked(
  email_input text default null,
  username_input text default null,
  phone_input text default null
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.blocked_client_identifiers blocked
    where (
        blocked.identifier_type = 'email'
        and blocked.identifier_value = public.normalize_block_identifier('email', email_input)
      )
      or (
        blocked.identifier_type = 'username'
        and blocked.identifier_value = public.normalize_block_identifier('username', username_input)
      )
      or (
        blocked.identifier_type = 'phone'
        and blocked.identifier_value = public.normalize_block_identifier('phone', phone_input)
      )
  )
$$;

create or replace function public.admin_get_blocked_client_identifiers()
returns setof public.blocked_client_identifiers
language sql
stable
security definer
set search_path = public
as $$
  select blocked.*
  from public.blocked_client_identifiers blocked
  where exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and rol in ('admin', 'super_admin')
  )
  order by blocked.created_at desc
$$;
