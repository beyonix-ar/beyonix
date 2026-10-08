-- Permisos administrativos coherentes: admin O super_admin.
--
-- Varias políticas heredadas exigían `profiles.rol = 'admin'` y dejaban afuera
-- a super_admin (el rol con más privilegios). Algunas no tenían ninguna
-- política hermana que lo cubriera:
--   * orden_items_admin_select   -> super_admin no leía ítems de pedidos.
--   * producto_variantes_admin_select -> super_admin no veía variantes inactivas.
--   * ordenes_admin_delete, resenas_admin_update, resenas_admin_delete.
-- Las demás eran duplicados de políticas "Admins can ..." que ya incluyen
-- super_admin; se alinean igual para que no quede ninguna regla sólo-admin.
--
-- Mínimo privilegio: sólo ('admin', 'super_admin'). operador, clientes y anon
-- no ganan nada. No se crean políticas para clientes: la privacidad de pedidos
-- (20261009130000) sigue igual. Sólo ALTER POLICY / REVOKE / GRANT; no toca datos.
--
-- Excepción intencional, sin cambios: undo_audit_log y la lectura de
-- audit_logs son sólo super_admin (deshacer/leer auditoría).
--
-- storage.objects (bucket imagenes-productos): storage_admin_* también dicen
-- 'admin', pero cada una tiene su par "Admins can ... product images" que ya
-- incluye super_admin, y el esquema storage no pertenece a este rol de
-- migración. Se dejan como están.

alter policy orden_items_admin_select on public.orden_items
  using (exists (select 1 from public.profiles
                 where profiles.id = auth.uid() and profiles.rol in ('admin', 'super_admin')));

alter policy ordenes_admin_update on public.ordenes
  using (exists (select 1 from public.profiles
                 where profiles.id = auth.uid() and profiles.rol in ('admin', 'super_admin')));
alter policy ordenes_admin_delete on public.ordenes
  using (exists (select 1 from public.profiles
                 where profiles.id = auth.uid() and profiles.rol in ('admin', 'super_admin')));

alter policy productos_admin_all on public.productos
  using (exists (select 1 from public.profiles
                 where profiles.id = auth.uid() and profiles.rol in ('admin', 'super_admin')));

alter policy imagenes_admin_all on public.imagenes_producto
  using (exists (select 1 from public.profiles
                 where profiles.id = auth.uid() and profiles.rol in ('admin', 'super_admin')));

alter policy producto_variantes_admin_select on public.producto_variantes
  using (exists (select 1 from public.profiles
                 where profiles.id = auth.uid() and profiles.rol in ('admin', 'super_admin')));
alter policy producto_variantes_admin_insert on public.producto_variantes
  with check (exists (select 1 from public.profiles
                      where profiles.id = auth.uid() and profiles.rol in ('admin', 'super_admin')));
alter policy producto_variantes_admin_update on public.producto_variantes
  using (exists (select 1 from public.profiles
                 where profiles.id = auth.uid() and profiles.rol in ('admin', 'super_admin')))
  with check (exists (select 1 from public.profiles
                      where profiles.id = auth.uid() and profiles.rol in ('admin', 'super_admin')));
alter policy producto_variantes_admin_delete on public.producto_variantes
  using (exists (select 1 from public.profiles
                 where profiles.id = auth.uid() and profiles.rol in ('admin', 'super_admin')));

alter policy resenas_admin_update on public.resenas
  using (exists (select 1 from public.profiles
                 where profiles.id = auth.uid() and profiles.rol in ('admin', 'super_admin')));
alter policy resenas_admin_delete on public.resenas
  using (exists (select 1 from public.profiles
                 where profiles.id = auth.uid() and profiles.rol in ('admin', 'super_admin')));

-- RPC administrativas: validan el rol adentro, pero anon (y PUBLIC, que
-- incluye a anon) no tienen por qué poder ejecutarlas. 20261009130000 revocó
-- undo_audit_log a anon, sin efecto mientras PUBLIC conservara EXECUTE.
revoke execute on function public.admin_get_client_carts() from public, anon;
revoke execute on function public.admin_get_client_presence() from public, anon;
revoke execute on function public.admin_get_blocked_client_identifiers() from public, anon;
revoke execute on function public.notify_customers_about_offer(text, text, text) from public, anon;
revoke execute on function public.undo_audit_log(bigint) from public, anon;
revoke execute on function public.create_producto_completo(jsonb, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.admin_get_client_carts() to authenticated, service_role;
grant execute on function public.admin_get_client_presence() to authenticated, service_role;
grant execute on function public.admin_get_blocked_client_identifiers() to authenticated, service_role;
grant execute on function public.notify_customers_about_offer(text, text, text) to authenticated, service_role;
grant execute on function public.undo_audit_log(bigint) to authenticated, service_role;
grant execute on function public.create_producto_completo(jsonb, jsonb, jsonb, jsonb) to authenticated, service_role;

-- Auditoría: ninguna política de lectura aplica a anon; tampoco el privilegio.
revoke select on public.audit_logs, public.order_audit_events from anon;

notify pgrst, 'reload schema';
