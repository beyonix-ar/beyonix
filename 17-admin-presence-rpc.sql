-- Lectura segura para /admin de presencia y carritos.
-- Evita depender de policies complejas desde el cliente: la funcion valida
-- que quien llama sea admin/super_admin y luego devuelve los datos.

create or replace function public.is_current_user_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and rol in ('admin', 'super_admin')
  );
$$;

create or replace function public.admin_get_client_presence()
returns table (
  user_id uuid,
  last_seen_at timestamptz,
  current_path text,
  updated_at timestamptz
)
language sql
security definer
set search_path = public
stable
as $$
  select
    cp.user_id,
    cp.last_seen_at,
    cp.current_path,
    cp.updated_at
  from public.client_presence cp
  where public.is_current_user_admin()
  order by cp.updated_at desc;
$$;

create or replace function public.admin_get_client_carts()
returns table (
  user_id uuid,
  payload jsonb,
  updated_at timestamptz,
  expires_at timestamptz
)
language sql
security definer
set search_path = public
stable
as $$
  select
    cc.user_id,
    cc.payload,
    cc.updated_at,
    cc.expires_at
  from public.client_carts cc
  where public.is_current_user_admin()
  order by cc.updated_at desc;
$$;

grant execute on function public.is_current_user_admin() to authenticated;
grant execute on function public.admin_get_client_presence() to authenticated;
grant execute on function public.admin_get_client_carts() to authenticated;
