-- Corrige una regresión real introducida por
-- 20260905130000_order_claims_row_level_security.sql (YA APLICADA, no se
-- toca de nuevo acá).
--
-- lib/admin/order-notifications.ts::getNewOrderNotificationSummary hace
--   supabase.from("order_claims").select(...).eq("admin_needs_action", true)
-- usando el cliente de navegador autenticado del propio Admin (importado
-- de @/lib/supabase/client, NO createAdminClient/service_role) para
-- calcular el badge de notificaciones ("¿hay reclamos que necesitan
-- atención?") que se muestra en app/admin/sections/pedidos/admin-pedidos.tsx.
--
-- Con RLS habilitado y sin ninguna policy (estado actual tras la migración
-- ya aplicada), esa consulta queda deny-by-default: el badge de
-- reclamos/mensajes del Admin dejaría de funcionar. Todo el resto de
-- lectura/escritura de order_claims (creación de reclamos, panel de
-- gestión del Admin, endpoints de decisión) sigue yendo 100% por
-- createAdminClient/service_role y no depende de esta policy en absoluto
-- -- service_role siempre hace bypass de RLS.
--
-- Se reutiliza el mismo patrón ya usado para "profiles" ("Internal users
-- can read all profiles", ver supabase/sql/020_roles_and_permissions.sql)
-- a través de la función security definer ya existente
-- public.is_current_user_internal() (true para operador/admin/
-- super_admin) -- no se inventa un mecanismo de autorización nuevo.
--
-- Sólo SELECT: no se otorga INSERT/UPDATE/DELETE vía RLS para el rol
-- authenticated, esas operaciones siguen exclusivamente del lado del
-- servidor.
drop policy if exists "Internal users can read order claims" on public.order_claims;
create policy "Internal users can read order claims"
on public.order_claims
for select
to authenticated
using (public.is_current_user_internal());
