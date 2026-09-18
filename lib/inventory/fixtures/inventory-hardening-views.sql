-- Se carga DESPUÉS de las migraciones reales (necesita
-- inventory_order_consumes_stock, definida en
-- 20260918110000_inventory_refresh_reproducibility.sql). Mismo predicado
-- exacto que la vista real de producción para cada rama que incluye
-- (fetchado via pg_get_viewdef el 2026-09-18) -- se omiten las ramas
-- external_sales/mercadolibre_sales/business_expenses por no ser parte de
-- esta fase, no porque se haya simplificado su lógica.

create view public.inventory_movements as
  select
    entries.product_id,
    entries.variant_id,
    entries.received_quantity::bigint as quantity_delta,
    entries.purchase_date as movement_date
  from public.product_cost_entries entries
  where entries.product_id is not null and entries.received_quantity <> 0
  union all
  select
    items.producto_id as product_id,
    items.variante_id as variant_id,
    (- items.cantidad)::bigint as quantity_delta,
    (orders.created_at)::date as movement_date
  from public.orden_items items
  join public.ordenes orders on orders.id = items.orden_id
  where items.conditioned_stock_id is null
    and public.inventory_order_consumes_stock(orders.estado, orders.payment_status)
  union all
  select
    movements.product_id,
    movements.variant_id,
    movements.sellable_quantity::bigint as quantity_delta,
    (movements.occurred_at)::date as movement_date
  from public.inventory_return_movements movements
  where movements.sellable_quantity <> 0
  union all
  select
    adjustments.product_id,
    adjustments.variant_id,
    adjustments.quantity_delta::bigint as quantity_delta,
    adjustments.adjustment_date as movement_date
  from public.inventory_stock_adjustments adjustments
  where adjustments.quantity_delta <> 0;
