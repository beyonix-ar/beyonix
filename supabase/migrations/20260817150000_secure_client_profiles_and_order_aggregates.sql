-- Corrige una vulnerabilidad crítica: admin_get_client_profiles() es
-- SECURITY DEFINER y estaba otorgada a `anon`/`authenticated` sin
-- validar el rol del llamante dentro de la función. Cualquier usuario
-- (incluso sin sesión) podía invocarla y obtener PII de todos los
-- clientes (email, teléfono, DNI, dirección).
--
-- El fix replica el patrón ya usado por admin_get_client_carts() y
-- admin_get_client_presence(): agregar `public.is_current_user_admin()`
-- al WHERE, de forma que un llamante no autorizado reciba un resultado
-- vacío en vez de datos reales. Se mantiene SECURITY DEFINER (necesario
-- para leer auth.users.email) y el search_path seguro ya existente.

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
    and public.is_current_user_admin()
  order by profiles.created_at desc;
$$;

revoke all on function public.admin_get_client_profiles() from public, anon, authenticated;
grant execute on function public.admin_get_client_profiles()
  to authenticated, service_role;

comment on function public.admin_get_client_profiles() is
  'Devuelve al panel administrativo clientes, administradores y superadministradores con sus datos completos. Sólo admin/super_admin obtienen filas (public.is_current_user_admin()); cualquier otro llamante recibe un resultado vacío.';

-- Agregados de órdenes por cliente calculados en SQL, para que
-- getClientes() deje de descargar la tabla `ordenes` completa al
-- navegador. Reproduce exactamente la lógica que hoy vive en
-- lib/supabase/queries/clientes.ts:
--   - una orden pertenece a un cliente si usuario_id = profile.id
--     O si el email (normalizado, trim + lower) coincide;
--   - order_count = todas las órdenes que matchean (cualquier estado);
--   - total_spent = suma de `total` sólo de las órdenes "pagadas"
--     (estado in pagado/enviado/entregado, o payment_status = approved);
--   - last_order = la orden matcheada más reciente (cualquier estado).
create or replace function public.admin_get_client_order_summaries()
returns table (
  profile_id uuid,
  order_count bigint,
  total_spent numeric,
  last_order jsonb
)
language sql
stable
security definer
set search_path = public, auth
as $$
  select
    p.id as profile_id,
    count(*)::bigint as order_count,
    coalesce(sum(o.total) filter (
      where o.estado in ('pagado', 'enviado', 'entregado')
        or o.payment_status = 'approved'
    ), 0) as total_spent,
    (array_agg(
      jsonb_build_object(
        'id', o.id,
        'usuario_id', o.usuario_id,
        'cliente_email', o.cliente_email,
        'total', o.total,
        'estado', o.estado,
        'payment_status', o.payment_status,
        'created_at', o.created_at
      )
      order by o.created_at desc, o.id desc
    ))[1] as last_order
  from public.profiles p
  left join auth.users u on u.id = p.id
  join lateral (
    select id, usuario_id, cliente_email, total, estado, payment_status, created_at
    from public.ordenes
    where usuario_id = p.id
    union
    select id, usuario_id, cliente_email, total, estado, payment_status, created_at
    from public.ordenes
    where u.email is not null
      and cliente_email is not null
      and lower(trim(cliente_email)) = lower(trim(u.email))
  ) o on true
  where p.rol in ('cliente', 'admin', 'super_admin')
    and public.is_current_user_admin()
  group by p.id;
$$;

revoke all on function public.admin_get_client_order_summaries() from public, anon, authenticated;
grant execute on function public.admin_get_client_order_summaries()
  to authenticated, service_role;

comment on function public.admin_get_client_order_summaries() is
  'Agregados de órdenes por cliente (order_count, total_spent, last_order) para el panel de clientes. Sólo admin/super_admin obtienen filas. Reemplaza la descarga completa de ordenes que hacía getClientes().';
