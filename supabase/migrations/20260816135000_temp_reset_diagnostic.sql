-- Artefacto temporal de diagnóstico. Ejecuta el reset dentro de un
-- SAVEPOINT propio y siempre revierte (rollback), nunca confirma cambios.
-- Se elimina junto con el resto de los artefactos temporales.

create or replace function public.__beyonix_temp_reset_dry_run()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.inventory_return_movements;
  delete from public.product_cost_entries;
  delete from public.business_expenses;
  delete from public.mercadolibre_sales;
  delete from public.external_sales;
  delete from public.order_credit_note_items;
  delete from public.order_credit_notes;
  delete from public.order_claim_files;
  delete from public.order_claim_messages;
  delete from public.order_claims;
  delete from public.customer_notifications;
  delete from public.stock_reservations;
  delete from public.orden_items;
  delete from public.ordenes;
  delete from public.reviews;
  delete from public.resenas;
  delete from public.product_favorites;
  delete from public.catalog_sku_registry;
  delete from public.inventory_variant_allocations;
  delete from public.inventory_opening_balances;
  delete from public.product_bulk_events;

  alter table public.inventory_operation_log
    disable trigger prevent_inventory_operation_log_mutation;
  delete from public.inventory_operation_log;
  alter table public.inventory_operation_log
    enable trigger prevent_inventory_operation_log_mutation;

  delete from public.producto_especificaciones;
  delete from public.imagenes_producto;
  delete from public.producto_variantes;
  delete from public.productos;

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

revoke all on function public.__beyonix_temp_reset_dry_run() from public, anon, authenticated;
grant execute on function public.__beyonix_temp_reset_dry_run() to service_role;
