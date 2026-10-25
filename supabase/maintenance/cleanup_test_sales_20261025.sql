-- Limpieza de ventas de prueba auditadas el 2026-10-25. No es migración.
-- Los IDs son una barrera de seguridad obtenida de la auditoría previa, no un descubrimiento destructivo.
-- Nunca ejecutar si alguno de los seis pedidos no fue confirmado como prueba.
-- Referencias fiscales externas conservadas para auditoría; este script no llama a ARCA:
-- BX-1012 F C 0001-00000016 CAE 86439023567367
-- BX-1013 F C 0001-00000017 CAE 86439024122897
-- BX-1014 F C 0001-00000018 CAE 86439024586680; NC C 0001-00000008 CAE 86439060216689
-- BX-1015 F C 0001-00000019 CAE 86439283113143; NC C 0001-00000009 CAE 86439344275360
-- BX-1016 F C 0001-00000020 CAE 86439344057728
-- BX-1017 F C 0001-00000021 CAE 86439344059039
-- Pagos MP: BX-1015 185922465678; BX-1016 184957976477; BX-1017 184957881355.
-- Envíos Andreani: BX-1012 API0000174441923; BX-1013 API0000174442303;
-- BX-1014 API0000174442671; BX-1015 API0000174606521;
-- BX-1016 API0000174626994; BX-1017 API0000174627013.
-- Los comprobantes externos siguen existiendo. Las cotizaciones checkout sin order_id no se atribuyen a pedidos.
begin isolation level serializable;
set local lock_timeout = '15s';
set local statement_timeout = '180s';

do $$
declare r record;
begin
  for r in select tablename from pg_tables where schemaname = 'public' order by tablename loop
    execute format('lock table public.%I in share row exclusive mode', r.tablename);
  end loop;
end $$;

do $$
begin
  if (select count(*) from public.ordenes) <> 6
    or (select array_agg(id order by id) from public.ordenes) is distinct from array[12,13,14,15,16,17]::bigint[]
    or exists (select 1 from public.ordenes where
      (id between 12 and 14 and usuario_id is distinct from '6ebd099d-2fd4-418b-b3b2-2ff212afad53'::uuid)
      or (id between 15 and 17 and usuario_id is distinct from '5e0bc67b-bbd3-40ca-8a71-35c8e503b3ad'::uuid))
    or (select count(*) from public.order_claims) <> 3
    or (select count(*) from public.dispatch_batches) <> 3
    or (select count(*) from public.reviews) <> 2
    or exists (select 1 from public.external_sales)
    or exists (select 1 from public.mercadolibre_sales)
    or (select count(*) from public.customer_credit_movements) <> 1
    or exists (select 1 from public.customer_credit_topups)
    or (select count(*) from public.order_credit_notes where status='authorized' and cae is not null) <> 2
    or (select count(*) from public.ordenes where invoice_status='authorized' and invoice_cae is not null) <> 6
    or (select count(*) from public.mercadopago_order_refunds) <> 1
  then raise exception 'La auditoría previa ya no coincide: limpieza cancelada'; end if;
end $$;

create temp table _target_orders on commit drop as select id from public.ordenes;
create temp table _target_items on commit drop as select id from public.orden_items where orden_id in (select id from _target_orders);
create temp table _target_stock_entities on commit drop as
  select distinct producto_id, variante_id from public.orden_items where id in (select id from _target_items);
create temp table _target_claims on commit drop as select id from public.order_claims where order_id in (select id from _target_orders);
create temp table _target_reviews on commit drop as select id from public.reviews where order_id in (select id from _target_orders);
create temp table _target_replacements on commit drop as select id, idempotency_key from public.order_replacements where original_order_id in (select id from _target_orders);
create temp table _target_returns on commit drop as select id from public.inventory_return_movements where order_id in (select id from _target_orders);
create temp table _target_batches on commit drop as select distinct b.id from public.dispatch_batches b join public.dispatch_batch_items i on i.batch_id=b.id where i.order_id in (select id from _target_orders);
create temp table _target_adjustments on commit drop as
  select a.id, a.idempotency_key from public.inventory_stock_adjustments a
  join _target_replacements r on a.idempotency_key = 'replacement:' || r.idempotency_key;
create temp table _target_sessions on commit drop as
  select session_id from public.checkout_reservation_sessions
  where order_id in (select id from _target_orders);
create temp table _target_credits on commit drop as
  select id from public.customer_credit_movements where order_id in (select id from _target_orders)
    or claim_id in (select id from _target_claims);
create temp table _target_catalog_stock_audits on commit drop as
with source_times as (
  select distinct created_at from public.audit_logs where
    (table_name='ordenes' and record_id in (select id::text from _target_orders))
    or (table_name='orden_items' and record_id in (select id::text from _target_items))
    or (table_name='inventory_return_movements' and record_id in (select id::text from _target_returns))
    or (table_name='order_replacements' and record_id in (select id::text from _target_replacements))
)
select a.id from public.audit_logs a join source_times s using(created_at)
where ((a.table_name='productos' and a.record_id in
    (select producto_id::text from public.orden_items where id in (select id from _target_items)))
  or (a.table_name='producto_variantes' and a.record_id in
    (select variante_id::text from public.orden_items where id in (select id from _target_items))))
  and (a.before_data-'stock'-'stock_adjustment_delta'-'stock_adjustment_reason')
    is not distinct from (a.after_data-'stock'-'stock_adjustment_delta'-'stock_adjustment_reason');

-- Captura de la proyección canónica sin ventas, devoluciones ni reemplazos de prueba.
create temp table _stock_audit on commit drop as
with expected_movements as (
  select m.* from public.inventory_movements m
  where m.movement_date <= current_date
    and not (m.source = 'web_sale' and m.source_id in (select id::text from _target_items))
    and not (m.source = 'approved_return' and m.source_id in (select id::text from _target_returns))
    and not (m.source = 'stock_adjustment' and m.source_id in (select id::text from _target_adjustments))
)
select p.id product_id, null::bigint variant_id, p.nombre product_name, null::text variant_name,
  p.stock stock_before, coalesce(sum(m.quantity_delta),0)::numeric stock_expected
from public.productos p left join expected_movements m on m.product_id=p.id
group by p.id,p.nombre,p.stock
union all
select v.producto_id,v.id,p.nombre,v.nombre,v.stock,
  (coalesce(sum(m.quantity_delta),0)+coalesce(max(a.quantity),0))::numeric
from public.producto_variantes v join public.productos p on p.id=v.producto_id
left join expected_movements m on m.product_id=v.producto_id and m.variant_id=v.id
left join public.inventory_variant_allocations a on a.variant_id=v.id
group by v.producto_id,v.id,p.nombre,v.nombre,v.stock;

do $$ begin
  if exists (select 1 from _stock_audit where stock_expected < 0) then
    raise exception 'Stock esperado negativo: limpieza cancelada';
  end if;
  if (select count(*) from _target_batches) <> 3
    or (select count(*) from _target_returns) <> 1
    or (select count(*) from _target_adjustments) <> 1
    or (select count(*) from _target_credits) <> 1
    or (select count(*) from _target_catalog_stock_audits) <> 80
    or exists (select 1 from public.dispatch_batch_items where batch_id in (select id from _target_batches)
      and order_id not in (select id from _target_orders))
    or exists (select 1 from public.inventory_return_movements where id in (select id from _target_returns)
      and mercadolibre_sale_id is not null) then
    raise exception 'Dependencias auditadas cambiaron: limpieza cancelada';
  end if;
end $$;

-- Huella de cada tabla que debe permanecer idéntica; productos y variantes
-- sólo pueden cambiar en stock derivado.
create temp table _preserved_hashes(table_name text primary key, fingerprint text) on commit drop;
do $$
declare r record; v_expression text;
begin
  for r in select tablename from pg_tables where schemaname='public' and tablename not in (
    'ordenes','orden_items','reviews','resenas','order_claims','order_claim_messages',
    'order_claim_files','order_claim_customer_reads','order_claim_financial_exceptions',
    'order_claim_item_resolutions','order_claim_operations','order_claim_shipments',
    'order_claim_units','order_claim_unit_events','order_credit_notes','order_credit_note_items',
    'order_refund_proofs','order_replacements','order_financial_resolutions',
    'order_audit_events','order_audit_incident_resolutions','order_cancellation_holds',
    'order_packages','order_package_parcels','order_preparation_lines','order_preparation_scans',
    'order_preparation_resets','order_preparation_adjustments','dispatch_batches',
    'dispatch_batch_items','dispatch_batch_events','dispatch_batch_parcel_scans',
    'dispatch_blocks','andreani_tracking_events','andreani_quote_snapshots',
    'andreani_billing_entries','arca_invoice_header_snapshots','arca_invoice_item_snapshots',
    'mercadopago_order_refunds','transfer_verification_payment_claims',
    'stock_reservations','checkout_reservation_sessions','inventory_return_movements',
    'inventory_stock_adjustments','inventory_operation_log','audit_logs',
    'customer_notifications','customer_order_signals','customer_store_benefits',
    'customer_credit_movements','admin_notification_reads','admin_order_event_views',
    'order_return_inspections'
  ) order by tablename loop
    v_expression := case when r.tablename in ('productos','producto_variantes') then '(to_jsonb(t)-''stock'')' else 'to_jsonb(t)' end;
    execute format('insert into _preserved_hashes select %L, md5(coalesce(string_agg(md5(%s::text), '','' order by md5(%s::text)), '''')) from public.%I t',
      r.tablename, v_expression, v_expression, r.tablename);
  end loop;
end $$;

create temp table _before_counts on commit drop as select
  (select count(*) from public.ordenes) orders,
  (select count(*) from public.dispatch_batches) batches,
  (select count(*) from public.order_claims) claims,
  (select count(*) from public.reviews where order_id in (select id from _target_orders)) reviews,
  (select count(*) from public.customer_notifications where order_id in (select id from _target_orders)) notifications,
  (select count(*) from public.andreani_tracking_events where order_id in (select id from _target_orders)) tracking_events,
  (select count(*) from public.order_claim_shipments where order_id in (select id from _target_orders)) claim_shipments,
  (select count(*) from public.product_cost_entries) purchases;

delete from public.stock_reservations
where order_id in (select id from _target_orders) or session_id in (select session_id from _target_sessions)
  or conditioned_stock_id in (select id from _target_returns);
delete from public.checkout_reservation_sessions where session_id in (select session_id from _target_sessions);
delete from public.customer_notifications where order_id in (select id from _target_orders);
delete from public.admin_notification_reads where
  (split_part(event_key,':',1) in ('order','invoice','claim','dispatch','dispatch-hold','payment','cancellation')
    and (split_part(event_key,':',2) in (select id::text from _target_orders)
      or split_part(event_key,':',2) in (select id::text from _target_claims)
      or split_part(event_key,':',2) in (select id::text from _target_batches)))
  or (event_key like 'cancellation:customer:%'
    and split_part(event_key,':',3) in (select id::text from _target_orders));
delete from public.customer_order_signals where order_id in (select id from _target_orders);
delete from public.admin_order_event_views where order_id in (select id from _target_orders);
delete from public.customer_store_benefits where source_order_id in (select id from _target_orders);
delete from public.customer_credit_movements where order_id in (select id from _target_orders)
  or claim_id in (select id from _target_claims)
  or credit_note_id in (select lpad(invoice_point::text,4,'0') || '-' || lpad(invoice_number::text,8,'0')
    from public.order_credit_notes where order_id in (select id from _target_orders));
delete from public.transfer_verification_payment_claims where order_id in (select id from _target_orders);
delete from public.mercadopago_order_refunds where order_id in (select id from _target_orders);
delete from public.andreani_billing_entries where order_id in (select id from _target_orders)
  or claim_shipment_id in (select id from public.order_claim_shipments where order_id in (select id from _target_orders));
delete from public.andreani_quote_snapshots where order_id in (select id from _target_orders);
delete from public.arca_invoice_item_snapshots where order_id in (select id from _target_orders);
delete from public.arca_invoice_header_snapshots where order_id in (select id from _target_orders);
delete from public.reviews where order_id in (select id from _target_orders);
delete from public.andreani_tracking_events where order_id in (select id from _target_orders)
  or claim_shipment_id in (select id from public.order_claim_shipments where order_id in (select id from _target_orders));

delete from public.order_audit_incident_resolutions where audit_event_id in
  (select id from public.order_audit_events where order_id in (select id from _target_orders));
delete from public.order_audit_events where order_id in (select id from _target_orders);
delete from public.order_claim_customer_reads where claim_id in (select id from _target_claims);
delete from public.order_claim_files where claim_id in (select id from _target_claims);
delete from public.order_claim_messages where claim_id in (select id from _target_claims);
delete from public.order_claim_financial_exceptions where claim_id in (select id from _target_claims);
delete from public.order_claim_item_resolutions where claim_id in (select id from _target_claims);
delete from public.order_claim_operations where claim_id in (select id from _target_claims);
delete from public.order_claim_unit_events where claim_id in (select id from _target_claims);
delete from public.order_claim_units where claim_id in (select id from _target_claims);
delete from public.order_claim_shipments where claim_id in (select id from _target_claims);
delete from public.order_replacements where original_order_id in (select id from _target_orders);
delete from public.order_refund_proofs where order_id in (select id from _target_orders);
delete from public.order_financial_resolutions where order_id in (select id from _target_orders);
delete from public.order_return_inspections where order_id in (select id from _target_orders);
delete from public.order_credit_note_items where credit_note_id in
  (select id from public.order_credit_notes where order_id in (select id from _target_orders));
delete from public.order_credit_notes where order_id in (select id from _target_orders);
delete from public.order_claims where id in (select id from _target_claims);

delete from public.dispatch_batch_parcel_scans where batch_id in (select id from _target_batches);
delete from public.dispatch_batch_events where batch_id in (select id from _target_batches);
delete from public.dispatch_batch_items where batch_id in (select id from _target_batches);
delete from public.order_cancellation_holds where order_id in (select id from _target_orders);
delete from public.dispatch_blocks where order_id in (select id from _target_orders);
delete from public.order_preparation_scans where package_id in
  (select id from public.order_packages where order_id in (select id from _target_orders));
delete from public.order_preparation_resets where package_id in
  (select id from public.order_packages where order_id in (select id from _target_orders));
delete from public.order_preparation_adjustments where order_id in (select id from _target_orders);
delete from public.order_preparation_lines where package_id in
  (select id from public.order_packages where order_id in (select id from _target_orders));
delete from public.order_package_parcels where order_id in (select id from _target_orders);
delete from public.order_packages where order_id in (select id from _target_orders);

delete from public.inventory_return_movements where id in (select id from _target_returns);
delete from public.inventory_stock_adjustments where id in (select id from _target_adjustments);
alter table public.inventory_operation_log disable trigger prevent_inventory_operation_log_mutation;
delete from public.inventory_operation_log where
  (source_table='orden_items' and source_id in (select id::text from _target_items))
  or (source_table='inventory_return_movements' and source_id in (select id::text from _target_returns))
  or (source_table='inventory_stock_adjustments' and source_id in (select idempotency_key from _target_adjustments));
alter table public.inventory_operation_log enable trigger prevent_inventory_operation_log_mutation;

delete from public.orden_items where id in (select id from _target_items);
alter table public.ordenes disable trigger guard_order_delete;
delete from public.ordenes where id in (select id from _target_orders);
alter table public.ordenes enable trigger guard_order_delete;
delete from public.dispatch_batches where id in (select id from _target_batches);

-- El trigger de auditoría genera filas al borrar y recalcular: quitarlas al final.
delete from public.audit_logs where
  (table_name='ordenes' and record_id in (select id::text from _target_orders))
  or (table_name='orden_items' and record_id in (select id::text from _target_items))
  or (table_name='reviews' and record_id in (select id::text from _target_reviews))
  or (table_name='inventory_return_movements' and record_id in (select id::text from _target_returns))
  or (table_name='order_replacements' and record_id in (select id::text from _target_replacements))
  or (table_name='customer_credit_movements' and record_id in (select id::text from _target_credits))
  or id in (select id from _target_catalog_stock_audits);

do $$ declare r record; begin
  for r in select distinct a.product_id from _stock_audit a
    left join public.productos p on p.id=a.product_id and a.variant_id is null
    left join public.producto_variantes v on v.id=a.variant_id
    where (case when a.variant_id is null then p.stock else v.stock end)
      is distinct from a.stock_expected
    order by a.product_id
  loop perform public.refresh_inventory_stock(r.product_id); end loop;
end $$;

-- Las actualizaciones de stock de esta misma transacción generan auditoría nueva.
delete from public.audit_logs where created_at = current_timestamp
  and ((table_name='productos' and record_id in
      (select distinct producto_id::text from _target_stock_entities))
    or (table_name='producto_variantes' and record_id in
      (select distinct variante_id::text from _target_stock_entities)))
  and (before_data-'stock'-'stock_adjustment_delta'-'stock_adjustment_reason')
    is not distinct from (after_data-'stock'-'stock_adjustment_delta'-'stock_adjustment_reason');

do $$
declare r record; v_hash text; v_expression text;
begin
  if exists (select 1 from _stock_audit a left join public.productos p on p.id=a.product_id and a.variant_id is null
    left join public.producto_variantes v on v.id=a.variant_id
    where (case when a.variant_id is null then p.stock else v.stock end) is distinct from a.stock_expected)
  then raise exception 'Stock final diferente del esperado'; end if;
  for r in select * from _preserved_hashes loop
    v_expression := case when r.table_name in ('productos','producto_variantes') then '(to_jsonb(t)-''stock'')' else 'to_jsonb(t)' end;
    execute format('select md5(coalesce(string_agg(md5(%s::text), '','' order by md5(%s::text)), '''')) from public.%I t',
      v_expression, v_expression, r.table_name) into v_hash;
    if v_hash is distinct from r.fingerprint then raise exception 'Tabla preservada modificada: %', r.table_name; end if;
  end loop;
  if exists (select 1 from public.ordenes) or exists (select 1 from public.orden_items)
    or exists (select 1 from public.dispatch_batches) or exists (select 1 from public.order_claims)
    or exists (select 1 from public.reviews) or exists (select 1 from public.andreani_tracking_events)
    or exists (select 1 from public.order_claim_shipments)
    or exists (select 1 from public.order_replacements)
    or exists (select 1 from public.order_financial_resolutions)
    or exists (select 1 from public.order_return_inspections)
    or exists (select 1 from public.order_credit_notes)
    or exists (select 1 from public.mercadopago_order_refunds)
    or exists (select 1 from public.inventory_return_movements)
    or exists (select 1 from public.order_cancellation_holds)
    or exists (select 1 from public.arca_invoice_header_snapshots)
    or exists (select 1 from public.arca_invoice_item_snapshots)
    or exists (select 1 from public.customer_notifications)
    or exists (select 1 from public.admin_notification_reads)
    or exists (select 1 from public.andreani_quote_snapshots where order_id in (select id from _target_orders))
    or exists (select 1 from public.checkout_reservation_sessions where order_id in (select id from _target_orders))
    or exists (select 1 from public.customer_credit_movements where order_id in (select id from _target_orders))
    or exists (select 1 from public.stock_reservations where order_id in (select id from _target_orders))
    or exists (select 1 from public.inventory_stock_adjustments where id in (select id from _target_adjustments))
    or exists (select 1 from pg_constraint where contype='f'
      and connamespace='public'::regnamespace and not convalidated)
    or (select count(*) from public.product_cost_entries) <> (select purchases from _before_counts)
  then raise exception 'Quedaron datos de prueba o cambió una compra'; end if;
end $$;

select b.*, (select count(*) from public.customer_credit_movements) credit_movements_after,
  (select count(*) from public.inventory_stock_adjustments) stock_adjustments_after from _before_counts b;
select product_id,variant_id,product_name,variant_name,stock_before,stock_expected,
  case when variant_id is null then (select stock from public.productos where id=product_id)
    else (select stock from public.producto_variantes where id=variant_id) end stock_final
from _stock_audit order by product_id,variant_id nulls first;
commit;
