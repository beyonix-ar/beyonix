-- Admin > Analítica: visualizaciones de productos por día de la semana.
--
-- admin_product_views_by_weekday es la ÚNICA agregación por día de la semana:
-- product_view del período (días de Argentina, inicio inclusive, fin
-- exclusivo del día siguiente) agrupados por día ISO de
-- America/Argentina/Buenos_Aires (1 = lunes ... 7 = domingo). Suma todas las
-- fechas de un mismo día (4 lunes = una sola fila "lunes"). Devuelve sólo los
-- días con vistas; el servidor completa los faltantes con 0.
--
-- admin_product_view_peak_weekday (20261026160000) se redefine para elegir el
-- ganador de esta misma distribución, así la card "Día con más
-- visualizaciones" y el gráfico no pueden divergir. Mismo contrato: día,
-- vistas y total; empate al día más temprano (lunes primero); sin vistas,
-- ninguna fila.

begin;

create or replace function public.admin_product_views_by_weekday(
  p_from date,
  p_to date
)
returns table (
  weekday integer,
  view_count bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    extract(isodow from e.occurred_at at time zone 'America/Argentina/Buenos_Aires')::integer,
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

revoke all on function public.admin_product_views_by_weekday(date, date) from public, anon, authenticated;
grant execute on function public.admin_product_views_by_weekday(date, date) to service_role;

comment on function public.admin_product_views_by_weekday(date, date) is
  'Admin > Analítica: product_view del período por día ISO de la semana (hora de Argentina). Sólo días con vistas.';

create or replace function public.admin_product_view_peak_weekday(
  p_from date,
  p_to date
)
returns table (
  peak_weekday integer,
  peak_views bigint,
  total_views bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with daily as (
    select d.weekday, d.view_count
    from public.admin_product_views_by_weekday(p_from, p_to) d
  )
  select d.weekday, d.view_count, (select sum(view_count) from daily)::bigint
  from daily d
  order by d.view_count desc, d.weekday asc
  limit 1;
$$;

revoke all on function public.admin_product_view_peak_weekday(date, date) from public, anon, authenticated;
grant execute on function public.admin_product_view_peak_weekday(date, date) to service_role;

comment on function public.admin_product_view_peak_weekday(date, date) is
  'Admin > Analítica: día de la semana con más product_view del período, elegido de admin_product_views_by_weekday, con el total para el porcentaje. Empate: el más temprano (lunes primero).';

commit;
