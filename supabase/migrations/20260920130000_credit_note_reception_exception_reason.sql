-- Auditoría 4/7 (devoluciones), Fase 2 punto 5.
--
-- reception_exception=true (saltea la exigencia de recepción física
-- aprobada antes de emitir NC/refund) no dejaba motivo ni cantidad
-- exceptuada -- sólo el booleano. Se agrega la columna de motivo; el actor
-- y la fecha ya quedaban en order_credit_notes.created_by/created_at.
-- Aditiva, nullable: no cambia nada para notas ya emitidas.

begin;

alter table public.order_credit_notes
  add column if not exists reception_exception_reason text;

commit;
