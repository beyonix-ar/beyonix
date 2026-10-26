-- Admin > Analítica: horario pico de visualizaciones de productos.
--
-- Agrupa los product_view del período (días de Argentina, extremos
-- inclusive, mismas reglas que admin_product_view_stats) por hora local de
-- America/Argentina/Buenos_Aires y devuelve SÓLO la franja ganadora junto con
-- el total del período (para el porcentaje). Cuenta visualizaciones, no
-- sesiones: cada product_view aceptado por record_product_view vale 1.
-- Empate: la franja más temprana del día. Sin vistas: ninguna fila.

begin;

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
    select
      extract(hour from e.occurred_at at time zone 'America/Argentina/Buenos_Aires')::integer as hour,
      count(*)::bigint as views
    from public.analytics_events e
    where e.event_type = 'product_view'
      and e.product_id is not null
      and e.occurred_at >= (p_from::timestamp at time zone 'America/Argentina/Buenos_Aires')
      and e.occurred_at < ((p_to + 1)::timestamp at time zone 'America/Argentina/Buenos_Aires')
    group by 1
  )
  select h.hour, h.views, (select sum(views) from hourly)::bigint
  from hourly h
  where p_from is not null and p_to is not null and p_from <= p_to
  order by h.views desc, h.hour asc
  limit 1;
$$;

revoke all on function public.admin_product_view_peak_hour(date, date) from public, anon, authenticated;
grant execute on function public.admin_product_view_peak_hour(date, date) to service_role;

comment on function public.admin_product_view_peak_hour(date, date) is
  'Admin > Analítica: franja horaria (hora de Argentina) con más product_view del período, con el total para el porcentaje. Empate: la más temprana.';

commit;
