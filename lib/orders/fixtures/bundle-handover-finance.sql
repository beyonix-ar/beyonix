-- Columnas reales del circuito financiero que usan la reserva de la
-- resolución y los avisos de reintegro. Se aplica después de
-- dispatch-inventory-schema.sql.
alter table order_credit_notes add column total_amount numeric default 0, add column destination text,
  add column settlement_status text, add column cae text;
alter table order_financial_resolutions add column amount numeric, add column selected_by uuid,
  add column status text not null default 'reserved';
