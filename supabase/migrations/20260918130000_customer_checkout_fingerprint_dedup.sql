-- FASE 1 (hardening P0 de ventas, Auditoría 2/7): dos pestañas del mismo
-- carrito podían generar dos órdenes reales (y dos pagos reales) para la
-- misma compra -- checkout_idempotency_key y el fingerprint de Mercado Pago
-- dependen de cartSessionId, que vive en sessionStorage (aislado por
-- pestaña, confirmado en la auditoría). Este constraint agrega un segundo
-- eje de deduplicación, anclado a la IDENTIDAD DEL CLIENTE (usuario_id) y
-- al contenido exacto del carrito (items + selección de envío + cupón),
-- independiente de la pestaña/sesión que originó el request.
--
-- Sólo aplica a pedidos AUTENTICADOS (customer_checkout_fingerprint queda
-- NULL para invitados -- no hay forma de identificar "misma persona, dos
-- pestañas" para un invitado sin otra señal estable, y un NULL nunca choca
-- contra otro NULL en un índice único). Índice único PARCIAL sobre
-- estado='pendiente': una vez que la orden se paga o se cancela (incluida
-- la expiración automática por cron ya existente para transferencia/MP),
-- deja de bloquear una futura compra legítima del mismo carrito -- no hace
-- falta ninguna ventana de tiempo arbitraria, el propio ciclo de vida de la
-- orden ya es la ventana.

begin;

alter table public.ordenes
  add column if not exists customer_checkout_fingerprint text;

create unique index if not exists ordenes_customer_checkout_fingerprint_pending_unique
  on public.ordenes (customer_checkout_fingerprint)
  where customer_checkout_fingerprint is not null and estado = 'pendiente';

commit;
