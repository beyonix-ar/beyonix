-- Cancelación operativa inmediata exclusiva de Super Admin. La factura, el
-- reintegro y el retorno físico siguen siendo obligaciones independientes.
alter table public.ordenes
  add column if not exists super_admin_stock_retained_at timestamptz;
comment on column public.ordenes.super_admin_stock_retained_at is
  'Conserva el consumo de stock al cancelar una venta ya despachada; un retorno físico aprobado genera su propio movimiento positivo.';

create or replace function public.super_admin_cancel_order(
  p_order_id bigint, p_actor_id uuid, p_reason_code text, p_reason_text text)
returns public.ordenes language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_order public.ordenes%rowtype;
  v_before public.ordenes%rowtype;
  v_batch record;
  v_hold_id bigint;
  v_now timestamptz := now();
  v_paid boolean;
  v_refund_due boolean;
  v_invoiced boolean;
  v_credit_pending boolean;
  v_dispatched boolean;
  v_stock_consumed boolean;
  v_units integer;
  v_stock_items jsonb;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'FORBIDDEN'; end if;
  if not exists (select 1 from public.profiles where id = p_actor_id and rol = 'super_admin')
    then raise exception 'SUPER_ADMIN_REQUIRED'; end if;
  if p_reason_code not in ('solicitud_cliente','pago_no_recibido','pago_invalido',
                          'falta_stock','error_administrativo','otro')
     or length(btrim(coalesce(p_reason_text,''))) not between 10 and 600
    then raise exception 'CANCELLATION_REASON_REQUIRED'; end if;

  select * into v_order from public.ordenes where id = p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  if v_order.estado = 'cancelado' then raise exception 'ORDER_ALREADY_CANCELLED'; end if;
  v_before := v_order;
  v_paid := v_order.paid_at is not null
    or coalesce(v_order.payment_confirmed_amount,0) > 0
    or coalesce(v_order.payment_status,'') in ('confirmado','approved','confirmed')
    or coalesce(v_order.financial_status,'') in ('payment_confirmed','refund_pending','refunded');
  v_invoiced := v_order.invoice_status = 'authorized'
    or v_order.invoice_cae is not null
    or (v_order.invoice_number is not null and v_order.invoice_point is not null);
  if v_invoiced then
    select coalesce(sum(total_amount),0) < coalesce(v_order.total,0)
      into v_credit_pending from public.order_credit_notes
      where order_id = p_order_id and status = 'authorized';
  else
    v_credit_pending := coalesce(v_order.credit_note_required,false);
  end if;
  v_refund_due := v_paid and v_order.financial_status is distinct from 'refunded';
  v_dispatched := v_order.andreani_handed_over_at is not null
    or v_order.estado in ('enviado','en_camino','visita_fallida','en_sucursal',
      'retiro_pendiente','retiro_vencido','en_devolucion','devuelto_beyonix','entregado');
  v_stock_consumed := public.inventory_order_consumes_stock(v_order.estado, v_order.payment_status);
  select coalesce(sum(cantidad),0)::integer,
    coalesce(jsonb_agg(jsonb_build_object('productId',producto_id,'variantId',variante_id,
      'conditionedStockId',conditioned_stock_id,'quantity',cantidad) order by id),'[]'::jsonb)
    into v_units,v_stock_items from public.orden_items where orden_id = p_order_id;
  select i.batch_id, b.code, b.status into v_batch
    from public.dispatch_batch_items i
    join public.dispatch_batches b on b.id = i.batch_id
    where i.order_id = p_order_id and i.removed_at is null
    limit 1;

  update public.ordenes set
    estado = 'cancelado', cancelled_at = v_now,
    cancellation_requested_at = v_now, cancellation_requested_by = p_actor_id,
    financial_status = case when v_refund_due then 'refund_pending'
      when v_order.financial_status = 'refunded' then 'refunded' else 'cancelled' end,
    refund_pending_at = case when v_refund_due then v_now else v_order.refund_pending_at end,
    credit_note_required = v_credit_pending,
    auto_cancellation_next_attempt_at = 'infinity'::timestamptz,
    super_admin_stock_retained_at = case when v_stock_consumed and v_dispatched then v_now
      else super_admin_stock_retained_at end
    where id = p_order_id returning * into v_order;

  select id into v_hold_id from public.order_cancellation_holds
    where order_id = p_order_id and resolved_at is null;

  insert into public.order_audit_events(
    order_id,actor_type,actor_id,action,previous_status,new_status,metadata)
  values (p_order_id,'admin',p_actor_id,'order_force_cancelled_by_super_admin',
    v_before.estado,v_order.estado,
    jsonb_build_object(
      'at',v_now,'reasonCode',p_reason_code,'reasonText',btrim(p_reason_text),
      'previousEstado',v_before.estado,'newEstado','cancelado',
      'batchId',v_batch.batch_id,'batchCode',v_batch.code,'batchStatus',v_batch.status,
      'stock',jsonb_build_object('units',v_units,'items',v_stock_items,'previouslyConsumed',v_stock_consumed,
        'physicalHoldId',v_hold_id,'dispatchedRetention',v_order.super_admin_stock_retained_at is not null,
        'resolution',case when v_hold_id is not null then 'physical_removal_pending'
          when v_order.super_admin_stock_retained_at is not null then 'return_pending'
          else 'released_by_existing_inventory_rules' end),
      'fiscal',jsonb_build_object('invoiceStatus',v_before.invoice_status,
        'invoiceCae',v_before.invoice_cae,'creditNoteRequired',v_order.credit_note_required,
        'resolution',case when v_order.credit_note_required then 'pending' else 'not_required' end),
      'financial',jsonb_build_object('previousStatus',v_before.financial_status,
        'newStatus',v_order.financial_status,'paymentStatus',v_before.payment_status,
        'creditBalanceUsed',v_before.credit_balance_used,
        'refundResolution',case when v_refund_due then 'pending'
          when v_order.financial_status = 'refunded' then 'completed' else 'not_required' end),
      'andreani',jsonb_build_object('creationStatus',v_before.andreani_creation_status,
        'envioId',v_before.andreani_envio_id,'tracking',v_before.andreani_tracking)));
  return v_order;
end $$;

revoke all on function public.super_admin_cancel_order(bigint,uuid,text,text)
  from public,anon,authenticated;
grant execute on function public.super_admin_cancel_order(bigint,uuid,text,text)
  to service_role;
comment on function public.super_admin_cancel_order(bigint,uuid,text,text) is
  'Cancelación operativa inmediata sólo para Super Admin; deja NC y reintegro pendientes, retiene stock físico y audita la intervención.';

-- Las tres vistas de inventario vigentes se redefinen abajo para conservar
-- consumido el stock de un pedido ya despachado hasta su retorno físico.

create or replace view public.inventory_movements
with (security_invoker = true)
as
select
  entries.product_id, entries.variant_id, entries.purchase_date as movement_date,
  entries.created_at as recorded_at, 'purchase'::text as source,
  entries.id::text as source_id, entries.received_quantity::bigint as quantity_delta,
  'purchase:' || entries.id::text as movement_id,
  'purchase'::text as movement_type,
  'product_cost_entries'::text as origin,
  entries.purchase_date::timestamp at time zone 'America/Argentina/Buenos_Aires' as effective_at,
  entries.created_by as responsible_user_id,
  'admin_purchase'::text as responsible_process,
  coalesce(entries.idempotency_key, 'purchase:' || entries.id::text) as idempotency_key,
  coalesce(nullif(btrim(entries.document_number), ''), entries.id::text) as document_reference
from public.product_cost_entries entries
where entries.product_id is not null and entries.received_quantity <> 0

union all

select
  items.producto_id, items.variante_id,
  (orders.created_at at time zone 'America/Argentina/Buenos_Aires')::date,
  orders.created_at, 'web_sale'::text, items.id::text, -items.cantidad::bigint,
  'web_sale:' || items.id::text, 'web_sale'::text, 'orden_items'::text,
  orders.created_at, orders.usuario_id, 'checkout'::text,
  coalesce(orders.checkout_idempotency_key, 'order-item:' || items.id::text),
  'order:' || orders.id::text
from public.orden_items items
join public.ordenes orders on orders.id = items.orden_id
where items.conditioned_stock_id is null
  and (public.inventory_order_consumes_stock(orders.estado, orders.payment_status)
       or public.order_has_active_stock_hold(orders.id) or orders.super_admin_stock_retained_at is not null)

union all

select
  sales.product_id, sales.variant_id, sales.sale_date, sales.created_at,
  'external_sale'::text, sales.id::text, -sales.quantity::bigint,
  'external_sale:' || sales.id::text, 'external_sale'::text, 'external_sales'::text,
  sales.sale_date::timestamp at time zone 'America/Argentina/Buenos_Aires',
  sales.created_by, 'admin_external_sale'::text,
  'external-sale:' || sales.id::text,
  coalesce(nullif(btrim(sales.reference), ''), sales.id::text)
from public.external_sales sales
where sales.product_id is not null
  and sales.status <> 'reversed'

union all

select
  sales.product_id, public.inventory_ml_variant_id(sales.raw_data),
  coalesce(
    (sales.sale_date at time zone 'America/Argentina/Buenos_Aires')::date,
    (sales.imported_at at time zone 'America/Argentina/Buenos_Aires')::date
  ),
  sales.imported_at, 'mercadolibre_sale'::text, sales.id::text,
  -public.inventory_ml_stock_units(sales.quantity, sales.raw_data)::bigint,
  'mercadolibre_sale:' || sales.id::text, 'mercadolibre_sale'::text,
  'mercadolibre_sales'::text, coalesce(sales.sale_date, sales.imported_at),
  sales.imported_by, 'mercadolibre_import'::text,
  coalesce(sales.source_key, 'mercadolibre-sale:' || sales.id::text),
  coalesce(nullif(btrim(sales.operation_id), ''), nullif(btrim(sales.order_id), ''), sales.id::text)
from public.mercadolibre_sales sales
where sales.product_id is not null
  and public.inventory_ml_stock_units(sales.quantity, sales.raw_data) > 0

union all

select
  movements.product_id, movements.variant_id,
  (movements.occurred_at at time zone 'America/Argentina/Buenos_Aires')::date,
  movements.created_at, 'approved_return'::text, movements.id::text,
  movements.sellable_quantity::bigint,
  'approved_return:' || movements.id::text, 'return'::text,
  'inventory_return_movements'::text,
  coalesce(movements.occurred_at, movements.approved_at, movements.created_at),
  movements.approved_by, 'return_review'::text,
  movements.source_key,
  coalesce(
    case when movements.mercadolibre_sale_id is not null
      then 'mercadolibre-sale:' || movements.mercadolibre_sale_id::text end,
    case when movements.order_item_id is not null
      then 'order-item:' || movements.order_item_id::text end,
    movements.id::text
  )
from public.inventory_return_movements movements
where movements.sellable_quantity <> 0

union all

select
  expenses.product_id, expenses.variant_id, expenses.expense_date,
  expenses.created_at, 'product_expense'::text, expenses.id::text,
  -expenses.quantity::bigint,
  'product_expense:' || expenses.id::text, 'write_off'::text,
  'business_expenses'::text,
  expenses.expense_date::timestamp at time zone 'America/Argentina/Buenos_Aires',
  expenses.created_by, 'admin_product_expense'::text,
  coalesce(expenses.idempotency_key, 'product-expense:' || expenses.id::text),
  coalesce(nullif(btrim(expenses.document_number), ''), expenses.id::text)
from public.business_expenses expenses
where expenses.expense_type = 'product'
  and expenses.product_id is not null
  and expenses.quantity is not null

union all

select
  adjustments.product_id, adjustments.variant_id, adjustments.adjustment_date,
  adjustments.created_at, 'stock_adjustment'::text, adjustments.id::text,
  adjustments.quantity_delta::bigint,
  'stock_adjustment:' || adjustments.id::text, 'adjustment'::text,
  'inventory_stock_adjustments'::text,
  adjustments.created_at, adjustments.created_by, 'admin_stock_adjustment'::text,
  coalesce(adjustments.idempotency_key, 'stock-adjustment:' || adjustments.id::text),
  adjustments.reason
from public.inventory_stock_adjustments adjustments
where adjustments.quantity_delta <> 0;

create or replace view public.conditioned_inventory_offers
with (security_invoker = true)
as
select
  movements.id,
  movements.product_id,
  movements.variant_id as source_variant_id,
  movements.conditioned_name as name,
  movements.conditioned_sku as sku,
  movements.conditioned_color_hex as color_hex,
  movements.conditioned_images as images,
  movements.discounted_quantity::integer as original_quantity,
  coalesce(sales.quantity, 0)::integer as sold_quantity,
  greatest(
    movements.discounted_quantity - coalesce(sales.quantity, 0),
    0
  )::integer as available_quantity,
  movements.discount_percent,
  movements.discount_reason as reason,
  movements.conditioned_active as active,
  movements.approved_at
from public.inventory_return_movements movements
left join lateral (
  select sum(
    greatest(
      items.cantidad - coalesce(items.return_restocked_quantity, 0),
      0
    )
  ) as quantity
  from public.orden_items items
  join public.ordenes orders on orders.id = items.orden_id
  where items.conditioned_stock_id = movements.id
    and (public.inventory_order_consumes_stock(
      orders.estado,
      orders.payment_status
    ) or public.order_has_active_stock_hold(orders.id) or orders.super_admin_stock_retained_at is not null)
) sales on true
where movements.discounted_quantity > 0;

create or replace view public.conditioned_catalog_variants
with (security_barrier = true, security_invoker = false)
as
select
  movements.id,
  movements.product_id,
  movements.variant_id as source_variant_id,
  movements.conditioned_name as name,
  movements.conditioned_sku as sku,
  movements.conditioned_color_hex as color_hex,
  movements.conditioned_images as images,
  movements.discounted_quantity::integer as original_quantity,
  coalesce(sales.quantity, 0)::integer as sold_quantity,
  greatest(
    movements.discounted_quantity - coalesce(sales.quantity, 0),
    0
  )::integer as available_quantity,
  movements.discount_percent,
  movements.discount_reason as reason,
  movements.approved_at
from public.inventory_return_movements movements
join public.productos products on products.id = movements.product_id
left join lateral (
  select sum(
    greatest(
      items.cantidad - coalesce(items.return_restocked_quantity, 0),
      0
    )
  ) as quantity
  from public.orden_items items
  join public.ordenes orders on orders.id = items.orden_id
  where items.conditioned_stock_id = movements.id
    and (public.inventory_order_consumes_stock(
      orders.estado,
      orders.payment_status
    ) or public.order_has_active_stock_hold(orders.id) or orders.super_admin_stock_retained_at is not null)
) sales on true
where movements.conditioned_active
  and products.activo
  and movements.discounted_quantity > coalesce(sales.quantity, 0)
  and nullif(btrim(movements.conditioned_name), '') is not null
  and nullif(btrim(movements.conditioned_sku), '') is not null
  and movements.conditioned_color_hex ~ '^#[0-9A-Fa-f]{6}$';

notify pgrst, 'reload schema';
