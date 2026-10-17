-- RESET TOTAL DE DATOS DE VENTA DE PRUEBA.
-- Ejecutar con: supabase db query --linked --project-ref <ref> --file supabase/maintenance/reset_customer_test_sales.sql
-- Una sola transacción. Conserva catálogo, proveedores, compras, ajustes y usuarios.
begin isolation level serializable;
set local lock_timeout = '15s';
set local statement_timeout = '180s';

lock table public.ordenes, public.orden_items, public.productos,
  public.producto_variantes, public.product_cost_entries,
  public.inventory_opening_balances, public.inventory_variant_allocations,
  public.inventory_stock_adjustments, public.inventory_return_movements,
  public.dispatch_batches in share row exclusive mode;

create temp table _reset_counts on commit drop as
select (select count(*) from public.ordenes) orders,
  (select count(*) from public.orden_items) items,
  (select count(*) from public.order_claims) claims,
  (select count(*) from public.external_sales) external_sales,
  (select count(*) from public.mercadolibre_sales) mercadolibre_sales,
  (select count(*) from public.mercadopago_order_refunds) refunds,
  (select count(*) from public.dispatch_batches) batches,
  (select count(*) from public.product_cost_entries) purchases,
  (select count(*) from public.productos) products,
  (select count(*) from public.producto_variantes) variants,
  (select count(*) from public.categorias) categories,
  (select count(*) from public.profiles) profiles;

create temp table _reset_order_returns on commit drop as
select id from public.inventory_return_movements
where order_id is not null or order_item_id is not null
   or mercadolibre_sale_id is not null;

-- Proyección esperada: todas las entradas y ajustes legítimos, sin ventas web
-- ni devoluciones provenientes de los pedidos que se eliminan.
create temp table _reset_expected_product on commit drop as
select p.id, coalesce(sum(m.quantity_delta) filter (
  where m.source not in ('web_sale', 'external_sale', 'mercadolibre_sale')
    and not (m.source = 'approved_return' and m.source_id in
      (select id::text from _reset_order_returns))
    and m.movement_date <= current_date), 0)::numeric as expected
from public.productos p left join public.inventory_movements m on m.product_id = p.id
group by p.id;

create temp table _reset_expected_variant on commit drop as
select v.id, (coalesce(sum(m.quantity_delta) filter (
  where m.source not in ('web_sale', 'external_sale', 'mercadolibre_sale')
    and not (m.source = 'approved_return' and m.source_id in
      (select id::text from _reset_order_returns))
    and m.movement_date <= current_date), 0)
  + coalesce(max(a.quantity), 0))::numeric as expected
from public.producto_variantes v
left join public.inventory_movements m on m.variant_id = v.id and m.product_id = v.producto_id
left join public.inventory_variant_allocations a on a.variant_id = v.id
group by v.id;

do $check$
begin
  if exists (select 1 from _reset_expected_product where expected < 0)
    or exists (select 1 from _reset_expected_variant where expected < 0) then
    raise exception 'El stock esperado es negativo; se canceló el reset';
  end if;
end $check$;

-- Créditos de ventas y toda su cadena de contrapartidas. Los créditos ajenos
-- a pedidos se conservan.
create temp table _reset_credit_ids on commit drop as
with recursive related(id) as (
  select id from public.customer_credit_movements
  where order_id is not null or claim_id is not null or credit_note_id is not null
  union
  select m.id from public.customer_credit_movements m
  join related r on m.related_movement_id = r.id
)
select distinct id from related;

-- Las recargas independientes no se borran. Una relación con ellas indica
-- saldo compartido que requiere tratamiento explícito antes de borrar.
do $check$
begin
  if exists (select 1 from public.customer_credit_topups t
    where t.credited_movement_id in (select id from _reset_credit_ids)
       or t.reversed_movement_id in (select id from _reset_credit_ids)) then
    raise exception 'Una recarga independiente referencia crédito de venta';
  end if;
end $check$;

delete from public.customer_credit_movements where id in (select id from _reset_credit_ids);
delete from public.customer_store_benefits where source_order_id is not null;
delete from public.checkout_reservation_sessions where order_id is not null;
delete from public.stock_reservations
where order_id is not null or conditioned_stock_id in (select id from _reset_order_returns);
delete from public.customer_notifications where order_id is not null;
delete from public.admin_notification_reads
where split_part(event_key, ':', 1) in
  ('order', 'invoice', 'claim', 'dispatch', 'dispatch-hold',
   'payment', 'cancellation', 'mercadolibre-return');
delete from public.customer_order_signals where order_id is not null;
delete from public.admin_order_event_views where order_id is not null;
delete from public.transfer_verification_payment_claims where order_id is not null;
delete from public.mercadopago_order_refunds where order_id is not null;
delete from public.andreani_billing_entries where order_id is not null;
delete from public.arca_invoice_item_snapshots where order_id is not null;
delete from public.arca_invoice_header_snapshots where order_id is not null;

delete from public.order_audit_incident_resolutions where true;
delete from public.order_audit_events where true;
delete from public.order_claim_customer_reads where true;
delete from public.order_claim_files where true;
delete from public.order_claim_messages where true;
delete from public.order_claim_financial_exceptions where true;
delete from public.order_claim_operations where true;
delete from public.order_claim_unit_events where true;
delete from public.order_claim_units where true;
delete from public.order_claim_shipments where true;
delete from public.order_replacements where true;
delete from public.order_refund_proofs where true;
delete from public.order_financial_resolutions where true;
delete from public.order_credit_note_items where true;
delete from public.order_credit_notes where true;
delete from public.order_claims where true;

delete from public.dispatch_batch_parcel_scans where true;
delete from public.dispatch_batch_events where true;
delete from public.dispatch_batch_items where true;
delete from public.order_cancellation_holds where true;
delete from public.dispatch_blocks where true;
update public.ordenes set andreani_handed_over_batch_id = null
where andreani_handed_over_batch_id is not null;
delete from public.dispatch_batches where true;
delete from public.dispatch_batch_day_sequences where true;

delete from public.order_preparation_scans where true;
delete from public.order_preparation_resets where true;
delete from public.order_preparation_adjustments where true;
delete from public.order_preparation_lines where true;
delete from public.order_package_parcels where true;
delete from public.order_packages where true;

delete from public.inventory_return_movements where id in (select id from _reset_order_returns);
delete from public.external_sales where true;
delete from public.mercadolibre_sales where true;
delete from public.mercadolibre_import_batches where true;

-- Este log es inmutable para la aplicación. Sólo se quitan sus filas
-- exclusivamente vinculadas a ventas/retornos de estos pedidos.
alter table public.inventory_operation_log disable trigger prevent_inventory_operation_log_mutation;
delete from public.inventory_operation_log
where source_table in ('orden_items', 'external_sales', 'mercadolibre_sales')
  or (source_table = 'inventory_return_movements' and source_id in
    (select id::text from _reset_order_returns));
alter table public.inventory_operation_log enable trigger prevent_inventory_operation_log_mutation;

delete from public.orden_items where true;
-- El guard de borrado individual impide pedidos facturados/reintegrados.
-- Este reset autorizado lo suspende sólo dentro de la transacción.
alter table public.ordenes disable trigger guard_order_delete;
delete from public.ordenes where true;
alter table public.ordenes enable trigger guard_order_delete;

delete from public.audit_logs where table_name in (
  'ordenes', 'orden_items', 'order_claims', 'order_claim_messages',
  'order_claim_files', 'order_credit_notes', 'order_credit_note_items',
  'order_refund_proofs', 'order_audit_events', 'stock_reservations',
  'dispatch_batches', 'dispatch_batch_items', 'order_packages',
  'external_sales', 'mercadolibre_sales', 'mercadolibre_import_batches');
delete from public.audit_logs
where table_name = 'inventory_return_movements'
  and record_id in (select id::text from _reset_order_returns);

do $refresh$
declare v_id bigint;
begin
  for v_id in select id from public.productos loop
    perform public.refresh_inventory_stock(v_id);
  end loop;
end $refresh$;

do $verify$
begin
  if exists (select 1 from _reset_expected_product e join public.productos p using (id)
    where p.stock is distinct from e.expected)
    or exists (select 1 from _reset_expected_variant e join public.producto_variantes v using (id)
      where v.stock is distinct from e.expected) then
    raise exception 'El stock final no coincide con la proyección sin ventas';
  end if;
  if (select count(*) from public.ordenes) <> 0
    or (select count(*) from public.orden_items) <> 0
    or (select count(*) from public.external_sales) <> 0
    or (select count(*) from public.mercadolibre_sales) <> 0
    or (select count(*) from public.order_claims) <> 0
    or (select count(*) from public.mercadopago_order_refunds) <> 0
    or (select count(*) from public.dispatch_batches) <> 0
    or (select count(*) from public.order_preparation_lines) <> 0
    or (select count(*) from public.stock_reservations where order_id is not null) <> 0
    or (select count(*) from public.customer_credit_movements
      where order_id is not null or claim_id is not null or credit_note_id is not null) <> 0
    or (select count(*) from public.admin_notification_reads
      where split_part(event_key, ':', 1) in
        ('order', 'invoice', 'claim', 'dispatch', 'dispatch-hold',
         'payment', 'cancellation', 'mercadolibre-return')) <> 0 then
    raise exception 'Quedaron datos de ventas';
  end if;
  if (select count(*) from public.product_cost_entries) <> (select purchases from _reset_counts)
    or (select count(*) from public.productos) <> (select products from _reset_counts)
    or (select count(*) from public.producto_variantes) <> (select variants from _reset_counts)
    or (select count(*) from public.categorias) <> (select categories from _reset_counts)
    or (select count(*) from public.profiles) <> (select profiles from _reset_counts) then
    raise exception 'Se alteró un dato maestro o una compra de proveedor';
  end if;
end $verify$;

-- La numeración visible de Bultos vuelve a 0001.
select setval('public.dispatch_batch_display_number_seq', 1, false);
select * from _reset_counts;
select id, expected as stock_sin_ventas from _reset_expected_product order by id;
select id, expected as stock_variante_sin_ventas from _reset_expected_variant order by id;
commit;
