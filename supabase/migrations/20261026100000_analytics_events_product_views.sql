-- Analítica (módulo 1): vistas de producto.
--
-- `analytics_events` es la tabla genérica de eventos de comportamiento de la
-- tienda. Esta versión sólo admite `product_view`; los próximos eventos
-- (add_to_cart, checkout_started, purchase_completed, search, page_view) se
-- agregan ampliando el CHECK de `event_type` y, si hace falta, con columnas
-- nullable propias -- nunca con otra tabla paralela.
--
-- Acceso exclusivamente server-side (service_role) a través de dos RPC:
--   * record_product_view: escritura con validación, deduplicación y límites.
--   * admin_product_view_stats: lectura agregada para Admin > Analítica.
-- Los clientes públicos (anon/authenticated) no pueden leer ni escribir la
-- tabla ni ejecutar las funciones.

begin;

create table if not exists public.analytics_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  occurred_at timestamptz not null default now(),
  -- Sesión anónima del navegador (UUID aleatorio, rota tras 30 min de
  -- inactividad). No identifica a una persona ni se cruza con el carrito.
  session_id uuid not null,
  -- Sólo cuando hay un usuario autenticado verificado server-side.
  user_id uuid references auth.users(id) on delete set null,
  product_id bigint references public.productos(id) on delete cascade,
  -- Reservado para eventos con variante elegida (p. ej. add_to_cart).
  variant_id bigint references public.producto_variantes(id) on delete set null,
  source text,
  device_type text,
  -- HMAC diario e irreversible del IP (nunca el IP), sólo para límites de abuso.
  client_key text,
  constraint analytics_events_event_type_check
    check (event_type in ('product_view')),
  constraint analytics_events_product_view_product_check
    check (event_type <> 'product_view' or product_id is not null),
  constraint analytics_events_source_check
    check (source is null or source in ('product_page', 'quick_view')),
  constraint analytics_events_device_type_check
    check (device_type is null or device_type in ('mobile', 'tablet', 'desktop')),
  constraint analytics_events_client_key_check
    check (client_key is null or client_key ~ '^[0-9a-f]{32}$')
);

-- Deduplicación (misma sesión + mismo producto) y límite por sesión.
create index if not exists analytics_events_product_view_session_idx
  on public.analytics_events (session_id, product_id, occurred_at desc)
  where event_type = 'product_view';

-- Agregaciones temporales por tipo de evento (rango de fechas).
create index if not exists analytics_events_type_occurred_idx
  on public.analytics_events (event_type, occurred_at desc);

-- Producto + fecha (ranking y futuros detalles por producto).
create index if not exists analytics_events_product_occurred_idx
  on public.analytics_events (product_id, occurred_at desc)
  where product_id is not null;

-- Límite de abuso por origen.
create index if not exists analytics_events_client_key_occurred_idx
  on public.analytics_events (client_key, occurred_at desc)
  where client_key is not null;

-- FK sin índice propio: borrar un usuario o una variante no debe barrer la tabla.
create index if not exists analytics_events_user_id_idx
  on public.analytics_events (user_id)
  where user_id is not null;

create index if not exists analytics_events_variant_id_idx
  on public.analytics_events (variant_id)
  where variant_id is not null;

alter table public.analytics_events enable row level security;

revoke all on table public.analytics_events from public, anon, authenticated;
grant select, insert, delete on table public.analytics_events to service_role;

comment on table public.analytics_events is
  'Eventos de analítica de la tienda (por ahora sólo product_view). Acceso exclusivo server-side vía RPC.';

-- Vista única: una sesión cuenta como máximo una vista por producto cada 30
-- minutos (desde la última vista contada). Refrescar o volver al producto
-- dentro de esa ventana no suma. El lock transaccional por
-- (sesión, producto) evita que dos requests simultáneos cuenten doble.
create or replace function public.record_product_view(
  p_session_id uuid,
  p_product_id bigint,
  p_user_id uuid default null,
  p_source text default null,
  p_device_type text default null,
  p_client_key text default null
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_dedup_window constant interval := interval '30 minutes';
  v_rate_window constant interval := interval '1 hour';
  v_max_per_session constant integer := 120;
  v_max_per_client constant integer := 600;
begin
  if p_session_id is null or p_product_id is null or p_product_id <= 0 then
    return 'invalid';
  end if;

  if not exists (
    select 1 from public.productos where id = p_product_id and activo is true
  ) then
    return 'invalid_product';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('analytics:product_view:' || p_session_id::text || ':' || p_product_id::text, 0)
  );

  if exists (
    select 1
    from public.analytics_events
    where event_type = 'product_view'
      and session_id = p_session_id
      and product_id = p_product_id
      and occurred_at > now() - v_dedup_window
  ) then
    return 'duplicate';
  end if;

  if (
    select count(*)
    from public.analytics_events
    where event_type = 'product_view'
      and session_id = p_session_id
      and occurred_at > now() - v_rate_window
  ) >= v_max_per_session then
    return 'rate_limited';
  end if;

  if p_client_key is not null and (
    select count(*)
    from public.analytics_events
    where client_key = p_client_key
      and occurred_at > now() - v_rate_window
  ) >= v_max_per_client then
    return 'rate_limited';
  end if;

  insert into public.analytics_events (
    event_type, session_id, user_id, product_id, source, device_type, client_key
  ) values (
    'product_view', p_session_id, p_user_id, p_product_id, p_source, p_device_type, p_client_key
  );

  return 'recorded';
end;
$$;

-- Ranking de productos vistos en un rango de fechas de Argentina (ambos
-- extremos inclusive). Sólo productos con al menos una vista.
create or replace function public.admin_product_view_stats(
  p_from date,
  p_to date
)
returns table (
  product_id bigint,
  product_name text,
  product_slug text,
  product_image text,
  views bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with counted as (
    select e.product_id, count(*)::bigint as views
    from public.analytics_events e
    where e.event_type = 'product_view'
      and e.occurred_at >= (p_from::timestamp at time zone 'America/Argentina/Buenos_Aires')
      and e.occurred_at < ((p_to + 1)::timestamp at time zone 'America/Argentina/Buenos_Aires')
    group by e.product_id
  )
  select
    c.product_id,
    p.nombre,
    p.slug,
    coalesce(
      nullif(btrim(p.imagen_principal), ''),
      (
        select i.url
        from public.imagenes_producto i
        where i.producto_id = p.id
        order by i.orden nulls last, i.id
        limit 1
      )
    ),
    c.views
  from counted c
  join public.productos p on p.id = c.product_id
  where p_from is not null and p_to is not null and p_from <= p_to
  order by c.views desc, p.nombre asc, c.product_id asc;
$$;

revoke all on function public.record_product_view(uuid, bigint, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.admin_product_view_stats(date, date) from public, anon, authenticated;
grant execute on function public.record_product_view(uuid, bigint, uuid, text, text, text) to service_role;
grant execute on function public.admin_product_view_stats(date, date) to service_role;

commit;
