-- Admin > Analítica: comparación contra el período inmediatamente anterior.
--
-- Una sola agregación para las métricas principales del período actual y del
-- anterior, con la MISMA definición de product_view que admin_product_view_stats
-- y admin_product_view_session_stats (event_type, product_id no nulo, días de
-- Argentina, inicio inclusive, fin exclusivo del día siguiente):
--   * total_views = "Vistas totales" (suma del ranking),
--   * products_viewed = "Productos vistos" (filas del ranking),
--   * sessions = "Sesiones con visualizaciones".
-- El promedio por sesión se calcula fuera con estos números base.
--
-- El período anterior debe terminar el día previo a p_from y durar lo mismo:
-- sin huecos ni solapamiento. Como son contiguos, se recorre un único rango
-- [inicio anterior, fin actual) sobre analytics_events_type_occurred_idx y cada
-- fila se asigna a su período con agregación condicional. Parámetros
-- inválidos: una fila en 0. Siempre devuelve una fila.

begin;

create or replace function public.admin_product_view_period_comparison(
  p_from date,
  p_to date,
  p_previous_from date,
  p_previous_to date
)
returns table (
  current_total_views bigint,
  current_products_viewed bigint,
  current_sessions bigint,
  previous_total_views bigint,
  previous_products_viewed bigint,
  previous_sessions bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with bounds as (
    select
      (p_previous_from::timestamp at time zone 'America/Argentina/Buenos_Aires') as previous_start,
      (p_from::timestamp at time zone 'America/Argentina/Buenos_Aires') as current_start,
      ((p_to + 1)::timestamp at time zone 'America/Argentina/Buenos_Aires') as current_end
    where p_from is not null and p_to is not null and p_from <= p_to
      and p_previous_from is not null and p_previous_to is not null
      and p_previous_to = p_from - 1
      and p_previous_to - p_previous_from = p_to - p_from
  ),
  scoped as (
    select e.product_id, e.session_id, e.occurred_at >= b.current_start as is_current
    from bounds b
    join public.analytics_events e
      on e.event_type = 'product_view'
     and e.product_id is not null
     and e.occurred_at >= b.previous_start
     and e.occurred_at < b.current_end
  )
  select
    count(*) filter (where is_current)::bigint,
    count(distinct product_id) filter (where is_current)::bigint,
    count(distinct session_id) filter (where is_current)::bigint,
    count(*) filter (where not is_current)::bigint,
    count(distinct product_id) filter (where not is_current)::bigint,
    count(distinct session_id) filter (where not is_current)::bigint
  from scoped;
$$;

revoke all on function public.admin_product_view_period_comparison(date, date, date, date) from public, anon, authenticated;
grant execute on function public.admin_product_view_period_comparison(date, date, date, date) to service_role;

comment on function public.admin_product_view_period_comparison(date, date, date, date) is
  'Admin > Analítica: vistas, productos vistos y sesiones del período y del inmediatamente anterior de igual duración, en una sola agregación con la definición de admin_product_view_stats.';

commit;
