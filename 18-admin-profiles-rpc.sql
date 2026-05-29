-- Lectura segura de clientes para /admin.
-- Soluciona casos donde RLS de profiles impide que el panel lea clientes,
-- aunque existan usuarios activos en client_presence.

create or replace function public.admin_get_client_profiles()
returns table (
  id uuid,
  email text,
  username text,
  nombre text,
  telefono text,
  direccion text,
  codigo_postal text,
  provincia text,
  referencias text,
  avatar_url text,
  rol text,
  created_at timestamptz
)
language sql
security definer
set search_path = public
stable
as $$
  select
    p.id,
    p.email,
    p.username,
    p.nombre,
    p.telefono,
    p.direccion,
    p.codigo_postal,
    p.provincia,
    p.referencias,
    p.avatar_url,
    p.rol,
    p.created_at
  from public.profiles p
  where public.is_current_user_admin()
    and coalesce(p.rol, 'cliente') not in ('admin', 'super_admin')
  order by p.created_at desc;
$$;

grant execute on function public.admin_get_client_profiles() to authenticated;
