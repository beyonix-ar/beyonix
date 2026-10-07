-- La fila única de arca_auto_invoicing_control (creada por
-- 20261003120000_arca_auto_invoicing_activation.sql) no existía en producción
-- (0 filas, sin eventos de activación): /api/cron/arca-invoices respondía 503
-- "Control automático ARCA no disponible" en cada corrida del timer.
--
-- Restaura exactamente el estado inicial documentado: facturación automática
-- APAGADA y sin cutoff. No activa nada, no toca pedidos ni comprobantes, y es
-- idempotente (no pisa una fila existente).
insert into public.arca_auto_invoicing_control (id, enabled)
values (true, false)
on conflict (id) do nothing;
