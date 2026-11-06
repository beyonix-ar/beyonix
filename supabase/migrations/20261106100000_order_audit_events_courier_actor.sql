-- Envío BEYONIX: el cadete (QR de la etiqueta, sin login) registra eventos en
-- order_audit_events con actor_type = 'courier' (lib/orders/local-delivery-deps
-- y public.local_delivery_audit de 20261105120000), pero el CHECK original sólo
-- admitía customer/admin/system. Cada inserción del cadete fallaba:
--   - "Entregado" desde el QR cambiaba el estado y activaba la garantía, pero
--     no podía registrar historial, garantía ni email (quedaban "pendientes");
--   - "No estaba" / "Incidencia" / retorno abortaban la RPC completa.
-- También se admite 'system' (ya permitido) para el reintento automático de
-- efectos (/api/cron/local-delivery-effects).
--
-- Reversible: volver al CHECK anterior exige que no queden filas 'courier'.
begin;

alter table public.order_audit_events
  drop constraint if exists order_audit_events_actor_type_check;

alter table public.order_audit_events
  add constraint order_audit_events_actor_type_check
  check (actor_type = any (array['customer'::text, 'admin'::text, 'system'::text, 'courier'::text]));

commit;
