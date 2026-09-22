-- Cambio de negocio: los clientes ya no pueden cargar saldo a favor por
-- ningún medio (transferencia, Mercado Pago ni ningún otro). La creación de
-- filas en customer_credit_topups ahora se bloquea directamente en las rutas
-- Next.js que antes la permitían (app/api/customer-credit/topups y
-- app/api/customer-credit/mercadopago/preference, ver esos archivos).
--
-- Esta migración es defensa en profundidad a nivel de GRANT, no la
-- protección principal: RLS ya bloqueaba el INSERT/UPDATE/DELETE directo
-- para un cliente normal, porque las únicas políticas de
-- customer_credit_topups son "Customers can read own credit topups" (SELECT
-- propio) y "Admins can manage credit topups" (admin/super_admin, ALL) --
-- nunca existió una política que permitiera escribir a un cliente común.
-- Revocar el privilegio de escritura a nivel de tabla cierra igual esa
-- puerta aunque en el futuro alguna ruta usara por error el cliente de
-- sesión del usuario en lugar del cliente admin.
--
-- No afecta a:
-- - service_role: ya tiene GRANT ALL propio (usado por todas las rutas
--   admin/webhook a través de createAdminClient()), independiente del GRANT
--   que aquí se revoca de 'authenticated'.
-- - Lectura de saldo/movimientos/historial de topups (customer_credit_movements,
--   GET de app/api/customer-credit/topups, balance, movements): sólo se toca
--   INSERT/UPDATE/DELETE.
-- - Las RPC que efectivamente acreditan saldo
--   (create_customer_credit_movement, resolve_customer_credit_topup,
--   credit_customer_credit_topup_from_mercadopago, etc.): ya están
--   restringidas a service_role desde
--   20260911130000_harden_customer_credit_rpc_authorization.sql.
-- - Capacidad administrativa de otorgar/ajustar saldo manualmente
--   (app/api/admin/clientes/saldos/route.ts,
--   app/api/admin/clientes/[id]/saldo/route.ts,
--   app/api/admin/customer-credit/route.ts): todas usan el cliente admin
--   (service_role) vía requireAdmin, no el GRANT de 'authenticated'.

begin;

revoke insert, update, delete on public.customer_credit_topups
  from authenticated;

notify pgrst, 'reload schema';

commit;
