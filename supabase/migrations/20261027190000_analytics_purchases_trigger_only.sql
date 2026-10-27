-- Analítica comercial: purchase_completed sólo la escribe el trigger de ordenes.
--
-- Supabase da por defecto todos los permisos de las tablas nuevas a
-- service_role, así que el "grant select" de 20261027170000 no alcanzaba:
-- el servidor también podía insertar compras. Ninguna ruta lo hace, pero la
-- garantía tiene que ser de la base: service_role sólo lee analytics_purchases
-- (el trigger analytics_record_purchase es security definer y sigue
-- escribiendo). analytics_order_sessions queda en lo que usa el checkout:
-- leer, insertar y borrar (nunca reasignar la sesión de una orden).

begin;

revoke insert, update, delete, truncate, references, trigger on table public.analytics_purchases from service_role;
grant select on table public.analytics_purchases to service_role;

revoke update, truncate, references, trigger on table public.analytics_order_sessions from service_role;
grant select, insert, delete on table public.analytics_order_sessions to service_role;

commit;
