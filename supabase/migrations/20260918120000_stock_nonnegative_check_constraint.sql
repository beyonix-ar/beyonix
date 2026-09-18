-- FASE 1 (hardening P0/P1 de inventario), punto 1: backstop de base de
-- datos contra stock negativo. Hasta ahora la única protección era de
-- aplicación (cada RPC de escritura valida bajo el mismo advisory lock
-- antes de dejar un movimiento negativo) -- sin ningún CHECK, un bug futuro
-- en cualquier código nuevo que llegue a escribir estas columnas quedaría
-- sin ningún freno de la base.
--
-- Auditoría previa (2026-09-18, sólo lectura contra producción):
--   select 'productos' as source, id, stock from public.productos where stock < 0
--   union all
--   select 'producto_variantes' as source, id, stock from public.producto_variantes where stock < 0;
-- -- 0 filas en ambas tablas. Sin esto, este archivo no se habría escrito
-- (la instrucción explícita era detener la migración y reportar, nunca
-- corregir datos en silencio).

begin;

alter table public.productos
  add constraint productos_stock_nonnegative_check check (stock >= 0);

alter table public.producto_variantes
  add constraint producto_variantes_stock_nonnegative_check check (stock >= 0);

commit;
