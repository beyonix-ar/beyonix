-- Admin > Analítica: sesiones con visualizaciones de productos.
--
-- Mismos product_view y mismo período que admin_product_view_stats (días de
-- Argentina, inicio inclusive, fin exclusivo del día siguiente), así
-- total_views coincide siempre con "Vistas totales". unique_sessions cuenta
-- cada session_id una sola vez en el período, sin importar cuántos productos
-- vio. No identifica personas: una sesión vence tras 30 minutos sin
-- actividad (ver record_product_view) y no se usan user_id, IP ni
-- client_key. session_id es NOT NULL desde 20261026100000: toda vista es
-- atribuible a una sesión. Siempre devuelve una fila (0, 0 sin vistas).

begin;

create or replace function public.admin_product_view_session_stats(
  p_from date,
  p_to date
)
returns table (
  total_views bigint,
  unique_sessions bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select count(*)::bigint, count(distinct e.session_id)::bigint
  from public.analytics_events e
  where p_from is not null and p_to is not null and p_from <= p_to
    and e.event_type = 'product_view'
    and e.product_id is not null
    and e.occurred_at >= (p_from::timestamp at time zone 'America/Argentina/Buenos_Aires')
    and e.occurred_at < ((p_to + 1)::timestamp at time zone 'America/Argentina/Buenos_Aires');
$$;

revoke all on function public.admin_product_view_session_stats(date, date) from public, anon, authenticated;
grant execute on function public.admin_product_view_session_stats(date, date) to service_role;

comment on function public.admin_product_view_session_stats(date, date) is
  'Admin > Analítica: product_view del período (mismo total que admin_product_view_stats) y session_id distintos que vieron al menos un producto.';

commit;
