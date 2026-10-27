-- Admin > Analítica: visualizaciones de productos por hora del día.
--
-- admin_product_views_by_hour es la ÚNICA agregación por hora: product_view
-- del período (días de Argentina, inicio inclusive, fin exclusivo del día
-- siguiente) agrupados por hora local de America/Argentina/Buenos_Aires
-- (0 ... 23). Suma la misma hora de todas las fechas (20 h del lunes + 20 h
-- del martes = una sola fila "20"). Devuelve sólo las horas con vistas; el
-- servidor completa las faltantes con 0.
--
-- admin_product_view_peak_hour (20261026140000) se redefine para elegir el
-- ganador de esta misma distribución, así la card "Horario pico de
-- visualizaciones" y el gráfico no pueden divergir. Mismo contrato: hora,
-- vistas y total; empate a la hora más temprana; sin vistas, ninguna fila.

begin;

create or replace function public.admin_product_views_by_hour(
  p_from date,
  p_to date
)
returns table (
  hour integer,
  view_count bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    extract(hour from e.occurred_at at time zone 'America/Argentina/Buenos_Aires')::integer,
    count(*)::bigint
  from public.analytics_events e
  where p_from is not null and p_to is not null and p_from <= p_to
    and e.event_type = 'product_view'
    and e.product_id is not null
    and e.occurred_at >= (p_from::timestamp at time zone 'America/Argentina/Buenos_Aires')
    and e.occurred_at < ((p_to + 1)::timestamp at time zone 'America/Argentina/Buenos_Aires')
  group by 1
  order by 1;
$$;

revoke all on function public.admin_product_views_by_hour(date, date) from public, anon, authenticated;
grant execute on function public.admin_product_views_by_hour(date, date) to service_role;

comment on function public.admin_product_views_by_hour(date, date) is
  'Admin > Analítica: product_view del período por hora del día (hora de Argentina, 0–23). Sólo horas con vistas.';

create or replace function public.admin_product_view_peak_hour(
  p_from date,
  p_to date
)
returns table (
  peak_hour integer,
  peak_views bigint,
  total_views bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with hourly as (
    select h.hour, h.view_count
    from public.admin_product_views_by_hour(p_from, p_to) h
  )
  select h.hour, h.view_count, (select sum(view_count) from hourly)::bigint
  from hourly h
  order by h.view_count desc, h.hour asc
  limit 1;
$$;

revoke all on function public.admin_product_view_peak_hour(date, date) from public, anon, authenticated;
grant execute on function public.admin_product_view_peak_hour(date, date) to service_role;

comment on function public.admin_product_view_peak_hour(date, date) is
  'Admin > Analítica: franja horaria con más product_view del período, elegida de admin_product_views_by_hour, con el total para el porcentaje. Empate: la más temprana.';

commit;
