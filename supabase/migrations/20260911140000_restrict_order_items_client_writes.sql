-- P1: la policy de INSERT sólo verificaba ownership, sin estado ni total.
-- Catálogo remoto inspeccionado el 2026-09-11:
-- RLS activo; anon/authenticated tenían ALL a nivel tabla y no grants
-- independientes a nivel columna. Policies: INSERT propio, SELECT propio y
-- orden_items_admin_all (ALL, profiles.rol = 'admin').
--
-- Consumidores de escritura verificados:
-- INSERT: insertCheckoutOrderItemsAndValidateInventory, invocado con
-- createAdminClient/service_role por checkout de saldo, transferencia y MP.
-- DELETE: deleteIncompleteCheckoutOrder, también con service_role.
-- UPDATE: garantías (API admin y activación por entrega/tracking), con
-- service_role; process_order_item_return_inventory (vía
-- process_claim_return_inventory) y merge_catalog_products son SECURITY
-- DEFINER, con EXECUTE restringido a service_role.
-- No hay escrituras directas necesarias desde el navegador. undo_audit_log
-- excluye orden_items de su lista de tablas reversibles.
--
-- Se conserva SELECT propio y el mismo predicado de lectura administrativa.
-- No cambia órdenes, ítems, totales, funciones, triggers, FKs ni inventario.

begin;

-- Incluye PUBLIC y todos los privilegios de escritura/mantenimiento.
-- SELECT se restituye a los mismos roles de API que ya lo tenían, bajo RLS.
revoke all privileges on table public.orden_items
  from public, anon, authenticated;

grant select on table public.orden_items to anon, authenticated;
grant select, insert, update, delete on table public.orden_items to service_role;

drop policy if exists "Users can insert own order items" on public.orden_items;

-- ALL autorizaba también escritura administrativa por sesión normal.
-- Conservamos sólo su lectura, sin ampliar el predicado a otros perfiles.
drop policy if exists orden_items_admin_all on public.orden_items;
create policy orden_items_admin_select
  on public.orden_items
  for select
  to authenticated
  using (
    exists (
      select 1 from public.profiles
      where profiles.id = auth.uid()
        and profiles.rol = 'admin'
    )
  );

notify pgrst, 'reload schema';

commit;
