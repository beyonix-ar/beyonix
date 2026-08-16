-- Corrige el artefacto temporal de diagnóstico: la base exige WHERE
-- explícito en todo DELETE. Sigue siendo de sólo diagnóstico (rollback
-- interno); se elimina junto con el resto de los artefactos temporales.

create or replace function public.__beyonix_temp_reset_dry_run()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product_id bigint;
begin
  delete from public.inventory_return_movements where true;
  delete from public.product_cost_entries where true;
  delete from public.business_expenses where true;
  delete from public.mercadolibre_sales where true;
  delete from public.external_sales where true;
  delete from public.order_credit_note_items where true;
  delete from public.order_credit_notes where true;
  delete from public.order_claim_files where true;
  delete from public.order_claim_messages where true;
  delete from public.order_claims where true;
  delete from public.customer_notifications where true;
  delete from public.stock_reservations where true;
  delete from public.orden_items where true;
  delete from public.ordenes where true;
  delete from public.reviews where true;
  delete from public.resenas where true;
  delete from public.product_favorites where true;
  delete from public.catalog_sku_registry where true;
  delete from public.inventory_variant_allocations where true;
  delete from public.inventory_opening_balances where true;
  delete from public.product_bulk_events where true;

  alter table public.inventory_operation_log
    disable trigger prevent_inventory_operation_log_mutation;
  delete from public.inventory_operation_log where true;
  alter table public.inventory_operation_log
    enable trigger prevent_inventory_operation_log_mutation;

  delete from public.producto_especificaciones where true;
  delete from public.imagenes_producto where true;

  -- Recalcula el stock derivado antes de borrar: quitar una asignación de
  -- inventory_variant_allocations no dispara por sí sola un recálculo.
  for v_product_id in select id from public.productos loop
    perform public.refresh_inventory_stock(v_product_id);
  end loop;

  delete from public.producto_variantes where true;
  delete from public.productos where true;

  delete from public.audit_logs
  where table_name in (
    'productos', 'producto_variantes', 'orden_items', 'ordenes',
    'product_cost_entries', 'business_expenses', 'mercadolibre_sales',
    'external_sales', 'inventory_return_movements', 'imagenes_producto'
  );

  raise exception 'DRY_RUN_OK';
exception
  when others then
    return jsonb_build_object(
      'sqlstate', sqlstate,
      'message', sqlerrm
    );
end;
$$;
