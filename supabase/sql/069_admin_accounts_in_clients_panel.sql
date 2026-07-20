create or replace function public.admin_get_client_profiles()
returns table (
  id uuid,
  created_at timestamptz,
  nombre text,
  username text,
  email text,
  telefono text,
  dni text,
  codigo_postal text,
  provincia text,
  avatar_url text,
  referencias text,
  client_risk_status text,
  admin_note text,
  blocked_at timestamptz,
  blocked_reason text,
  blocked_by uuid,
  calle text,
  numero text,
  piso text,
  departamento text,
  localidad text,
  rol text,
  direccion text
)
language sql
security definer
set search_path = public, auth
as $$
  select
    profiles.id,
    profiles.created_at,
    profiles.nombre,
    profiles.username,
    users.email::text as email,
    profiles.telefono,
    profiles.dni,
    profiles.codigo_postal,
    profiles.provincia,
    profiles.avatar_url,
    profiles.referencias,
    profiles.client_risk_status,
    profiles.admin_note,
    profiles.blocked_at,
    profiles.blocked_reason,
    profiles.blocked_by,
    profiles.calle,
    profiles.numero,
    profiles.piso,
    profiles.departamento,
    profiles.localidad,
    profiles.rol,
    nullif(
      concat_ws(
        ' ',
        nullif(profiles.calle, ''),
        nullif(profiles.numero, ''),
        case when nullif(profiles.piso, '') is not null
          then 'Piso ' || profiles.piso else null end,
        case when nullif(profiles.departamento, '') is not null
          then 'Depto ' || profiles.departamento else null end,
        nullif(profiles.localidad, ''),
        nullif(profiles.provincia, ''),
        case when nullif(profiles.codigo_postal, '') is not null
          then 'CP ' || profiles.codigo_postal else null end
      ),
      ''
    ) as direccion
  from public.profiles
  left join auth.users on users.id = profiles.id
  where profiles.rol in ('cliente', 'admin', 'super_admin')
  order by profiles.created_at desc;
$$;

revoke all on function public.admin_get_client_profiles() from public;
grant execute on function public.admin_get_client_profiles()
  to authenticated, service_role;

comment on function public.admin_get_client_profiles() is
  'Devuelve al panel administrativo clientes, administradores y superadministradores con sus datos completos.';
