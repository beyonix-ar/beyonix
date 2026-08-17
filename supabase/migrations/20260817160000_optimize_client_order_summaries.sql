-- Evita búsquedas correlacionadas por perfil en el agregado del panel de
-- clientes. Los dos caminos de identidad conservan la semántica anterior y
-- UNION elimina una orden repetida cuando coincide por usuario y por email.

create index if not exists ordenes_usuario_id_idx
  on public.ordenes (usuario_id);

create index if not exists ordenes_cliente_email_normalized_idx
  on public.ordenes ((lower(btrim(cliente_email))))
  where cliente_email is not null;

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
  with authorized_profiles as (
    select
      p.id,
      u.email
    from public.profiles p
    left join auth.users u on u.id = p.id
    where p.rol in ('cliente', 'admin', 'super_admin')
      and public.is_current_user_admin()
  ),
  matched_orders as (
    select
      p.id as profile_id,
      o.id,
      o.usuario_id,
      o.cliente_email,
      o.total,
      o.estado,
      o.payment_status,
      o.created_at
    from authorized_profiles p
    join public.ordenes o on o.usuario_id = p.id

    union

    select
      p.id as profile_id,
      o.id,
      o.usuario_id,
      o.cliente_email,
      o.total,
      o.estado,
      o.payment_status,
      o.created_at
    from authorized_profiles p
    join public.ordenes o
      on p.email is not null
      and o.cliente_email is not null
      and lower(btrim(o.cliente_email)) = lower(btrim(p.email))
  )
  select
    o.profile_id,
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
  from matched_orders o
  group by o.profile_id;
$$;

revoke all on function public.admin_get_client_order_summaries()
  from public, anon, authenticated;
grant execute on function public.admin_get_client_order_summaries()
  to authenticated, service_role;

comment on function public.admin_get_client_order_summaries() is
  'Agregados set-based de órdenes por cliente. Sólo admin/super_admin obtienen filas.';
