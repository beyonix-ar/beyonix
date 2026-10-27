-- Analítica: mínimo privilegio para service_role.
--
-- Supabase da por defecto TODOS los permisos de las tablas nuevas de public a
-- anon, authenticated y service_role; las migraciones de Analítica revocaron
-- anon/authenticated pero service_role conservaba escritura directa
-- (y TRUNCATE, REFERENCES, TRIGGER y MAINTAIN). El servidor sólo necesita:
--
--   * analytics_events: leer. Escriben únicamente las RPC SECURITY DEFINER
--     (record_product_view, record_add_to_cart, record_search,
--     record_checkout_started) y merge_catalog_products (reasigna product_id).
--   * analytics_product_snapshots: leer. Escriben
--     analytics_touch_product_snapshot, el trigger
--     analytics_snapshot_deleted_product y merge_catalog_products.
--   * analytics_order_sessions: leer e insertar (el checkout vincula la orden
--     con ON CONFLICT DO NOTHING: la primera atribución gana). Nunca modificar
--     ni borrar.
--   * analytics_purchases: sin cambios (ya endurecida en 20261027190000; sólo
--     escribe el trigger de ordenes).
--
-- Todas esas funciones son SECURITY DEFINER con owner postgres, que es owner de
-- las tablas: revocar a service_role no les quita nada. REVOKE ALL + GRANT
-- explícito (en vez de revocar privilegio por privilegio) para que no quede
-- ningún permiso heredado de los defaults, incluido MAINTAIN.
--
-- Defaults de Supabase: NO se tocan. ALTER DEFAULT PRIVILEGES aplica a todo el
-- esquema public (no se puede limitar a las tablas de Analítica) y afectaría a
-- todo BEYONIX. Regla para futuras migraciones de Analítica: cada tabla nueva
-- hace REVOKE ALL a public, anon, authenticated y service_role y luego GRANT
-- explícito de lo mínimo (los tests de permisos de Analítica lo verifican con
-- defaults equivalentes a los de Supabase).
--
-- merge_catalog_products: search_path pasa de "public" a "public, pg_temp".
-- Con sólo "public", Postgres busca pg_temp ANTES que public (un objeto
-- temporal podría hacerse pasar por una tabla). La función no usa tablas
-- temporales ni SQL dinámico y califica sus tablas con public., así que el
-- cambio no altera la fusión. Se cambia sólo la configuración, no el cuerpo.
--
-- Pendiente aparte (no se toca acá): las FK con ON DELETE CASCADE desde
-- ordenes hacia analytics_purchases y analytics_order_sessions.

begin;

revoke all on table public.analytics_events from public, anon, authenticated, service_role;
grant select on table public.analytics_events to service_role;

revoke all on table public.analytics_product_snapshots from public, anon, authenticated, service_role;
grant select on table public.analytics_product_snapshots to service_role;

revoke all on table public.analytics_order_sessions from public, anon, authenticated, service_role;
grant select, insert on table public.analytics_order_sessions to service_role;

alter function public.merge_catalog_products(bigint, bigint, uuid) set search_path = public, pg_temp;

commit;
