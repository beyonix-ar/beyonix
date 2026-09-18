-- Fixture aislado para probar el índice único parcial que agrega
-- 20260918130000_customer_checkout_fingerprint_dedup.sql (Fase 1, hardening
-- P0 de ventas). Sólo lo mínimo para ejercitar el índice real: no reutiliza
-- el resto del esquema de `ordenes` de otros fixtures para no arriesgar
-- regresión sobre sus tests ya existentes.

create table public.ordenes (
  id bigint generated always as identity primary key,
  usuario_id uuid,
  estado text not null default 'pendiente',
  customer_checkout_fingerprint text
);
