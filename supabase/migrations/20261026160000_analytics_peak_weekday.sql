-- Admin > Analítica: día de la semana con más visualizaciones de productos.
--
-- Mismas reglas que admin_product_view_peak_hour: días de Argentina (inicio
-- inclusive, fin exclusivo del día siguiente), cuenta visualizaciones (cada
-- product_view aceptado por record_product_view vale 1), no sesiones.
-- Agrupa por día ISO de America/Argentina/Buenos_Aires (1 = lunes ...
-- 7 = domingo) y devuelve SÓLO el día ganador con el total del período.
-- Empate: el día más temprano de la semana (lunes primero). Sin vistas:
-- ninguna fila.

begin;

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
    select
      extract(isodow from e.occurred_at at time zone 'America/Argentina/Buenos_Aires')::integer as weekday,
      count(*)::bigint as views
    from public.analytics_events e
    where e.event_type = 'product_view'
      and e.product_id is not null
      and e.occurred_at >= (p_from::timestamp at time zone 'America/Argentina/Buenos_Aires')
      and e.occurred_at < ((p_to + 1)::timestamp at time zone 'America/Argentina/Buenos_Aires')
    group by 1
  )
  select d.weekday, d.views, (select sum(views) from daily)::bigint
  from daily d
  where p_from is not null and p_to is not null and p_from <= p_to
  order by d.views desc, d.weekday asc
  limit 1;
$$;

revoke all on function public.admin_product_view_peak_weekday(date, date) from public, anon, authenticated;
grant execute on function public.admin_product_view_peak_weekday(date, date) to service_role;

comment on function public.admin_product_view_peak_weekday(date, date) is
  'Admin > Analítica: día de la semana (ISO, hora de Argentina) con más product_view del período, con el total para el porcentaje. Empate: el más temprano (lunes primero).';

commit;
