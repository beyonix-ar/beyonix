-- Analítica comercial: las compras de prueba clasificadas (ordenes.test_order_at,
-- ver 20261124120000_test_order_classification.sql) no cuentan como compras,
-- ingresos ni conversión. analytics_purchases no se toca (la sigue escribiendo
-- sólo el trigger y conserva el historial): los reportes leen
-- analytics_commercial_purchases(). Los tres cuerpos son idénticos a
-- 20261027180000_analytics_commerce_reports.sql salvo esa fuente.

begin;

create or replace function public.analytics_commercial_purchases()
returns setof public.analytics_purchases
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.*
  from public.analytics_purchases p
  join public.ordenes o on o.id = p.order_id
  where o.test_order_at is null;
$$;

revoke all on function public.analytics_commercial_purchases() from public, anon, authenticated;

create or replace function public.analytics_purchase_sessions()
returns table (session_id uuid)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select distinct os.session_id
  from public.analytics_order_sessions os
  join public.analytics_commercial_purchases() p on p.order_id = os.order_id;
$$;


create or replace function public.analytics_commerce_period(p_from date, p_to date)
returns table (
  viewed_sessions bigint,
  cart_sessions bigint,
  checkout_sessions bigint,
  funnel_cart bigint,
  funnel_checkout bigint,
  funnel_purchase bigint,
  purchases bigint,
  attributed_purchases bigint,
  revenue numeric,
  attributed_revenue numeric,
  evaluated_carts bigint,
  abandoned_carts bigint,
  abandoned_checkouts bigint,
  carts_in_progress bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with
  viewed as (select session_id from public.analytics_period_sessions('product_view', p_from, p_to)),
  added as (select session_id from public.analytics_period_sessions('add_to_cart', p_from, p_to)),
  checkout as (select session_id from public.analytics_period_sessions('checkout_started', p_from, p_to)),
  purchased as (select session_id from public.analytics_purchase_sessions()),
  carts as (
    select c.session_id,
      exists (select 1 from checkout k where k.session_id = c.session_id) as has_checkout,
      exists (select 1 from purchased p where p.session_id = c.session_id) as has_purchase,
      (
        select max(e.occurred_at)
        from public.analytics_events e
        where e.session_id = c.session_id and e.event_type in ('add_to_cart', 'checkout_started')
      ) as last_activity
    from (select session_id from added union select session_id from checkout) c
  ),
  funnel as (
    select v.session_id,
      exists (select 1 from purchased p where p.session_id = v.session_id) as reached_purchase,
      exists (select 1 from checkout k where k.session_id = v.session_id) as reached_checkout,
      exists (select 1 from added a where a.session_id = v.session_id) as reached_cart
    from viewed v
  ),
  period_purchases as (
    select p.revenue, os.session_id is not null as attributed
    from public.analytics_commercial_purchases() p
    left join public.analytics_order_sessions os on os.order_id = p.order_id
    where p_from is not null and p_to is not null and p_from <= p_to
      and p.confirmed_at >= (p_from::timestamp at time zone 'America/Argentina/Buenos_Aires')
      and p.confirmed_at < ((p_to + 1)::timestamp at time zone 'America/Argentina/Buenos_Aires')
  )
  select
    (select count(*) from viewed),
    (select count(*) from carts),
    (select count(*) from checkout),
    (select count(*) from funnel where reached_cart or reached_checkout or reached_purchase),
    (select count(*) from funnel where reached_checkout or reached_purchase),
    (select count(*) from funnel where reached_purchase),
    (select count(*) from period_purchases),
    (select count(*) from period_purchases where attributed),
    (select coalesce(sum(revenue), 0) from period_purchases),
    (select coalesce(sum(revenue), 0) from period_purchases where attributed),
    (select count(*) from carts where has_purchase or last_activity <= now() - interval '24 hours'),
    (select count(*) from carts where not has_purchase and not has_checkout and last_activity <= now() - interval '24 hours'),
    (select count(*) from carts where not has_purchase and has_checkout and last_activity <= now() - interval '24 hours'),
    (select count(*) from carts where not has_purchase and last_activity > now() - interval '24 hours');
$$;


create or replace function public.admin_product_conversion(p_from date, p_to date)
returns table (
  product_id bigint,
  product_name text,
  product_slug text,
  product_image text,
  product_available boolean,
  viewed_sessions bigint,
  added_sessions bigint,
  purchased_sessions bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with
  bounds as (
    select
      (p_from::timestamp at time zone 'America/Argentina/Buenos_Aires') as starts,
      ((p_to + 1)::timestamp at time zone 'America/Argentina/Buenos_Aires') as ends
    where p_from is not null and p_to is not null and p_from <= p_to
  ),
  viewers as (
    select distinct e.product_id, e.session_id
    from bounds b
    join public.analytics_events e
      on e.event_type = 'product_view' and e.product_id is not null
     and e.occurred_at >= b.starts and e.occurred_at < b.ends
  ),
  adders as (
    select distinct e.product_id, e.session_id
    from bounds b
    join public.analytics_events e
      on e.event_type = 'add_to_cart' and e.product_id is not null
     and e.occurred_at >= b.starts and e.occurred_at < b.ends
  ),
  buyers as (
    select distinct i.producto_id as product_id, os.session_id
    from public.analytics_commercial_purchases() p
    join public.analytics_order_sessions os on os.order_id = p.order_id
    join public.orden_items i on i.orden_id = p.order_id
    where i.producto_id is not null
  ),
  -- Cohorte por producto: sesiones que lo vieron. Agregaron y compraron se
  -- cuentan dentro de esa cohorte, así las conversiones nunca superan el 100%.
  counted as (
    select v.product_id,
      count(*)::bigint as viewed_sessions,
      count(*) filter (where exists (
        select 1 from adders a where a.product_id = v.product_id and a.session_id = v.session_id
      ))::bigint as added_sessions,
      count(*) filter (where exists (
        select 1 from buyers u where u.product_id = v.product_id and u.session_id = v.session_id
      ))::bigint as purchased_sessions
    from viewers v
    group by v.product_id
  )
  select
    c.product_id,
    coalesce(p.nombre, s.product_name, 'Producto eliminado'),
    coalesce(p.slug, s.product_slug, ''),
    case
      when p.id is not null then public.analytics_product_image(p.id, p.imagen_principal)
      else s.product_image
    end,
    coalesce(p.activo, false),
    c.viewed_sessions,
    c.added_sessions,
    c.purchased_sessions
  from counted c
  left join public.productos p on p.id = c.product_id
  left join public.analytics_product_snapshots s on s.product_id = c.product_id
  order by c.viewed_sessions desc, c.purchased_sessions desc, c.added_sessions desc,
    coalesce(p.nombre, s.product_name, 'Producto eliminado') asc, c.product_id asc
  limit 10;
$$;


revoke all on function public.analytics_purchase_sessions() from public, anon, authenticated;
revoke all on function public.analytics_commerce_period(date, date) from public, anon, authenticated;
revoke all on function public.admin_product_conversion(date, date) from public, anon, authenticated;
grant execute on function public.admin_product_conversion(date, date) to service_role;

commit;
