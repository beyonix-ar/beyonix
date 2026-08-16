-- Reset controlado de datos comerciales de PRUEBA para dejar BEYONIX listo
-- para una prueba integral desde cero.
--
-- Vacía: productos, variantes, compras, ventas (web/ML/externas), pedidos,
-- devoluciones/inventario condicionado, reclamos, notas de crédito,
-- reservas de stock, notificaciones comerciales, historial de inventario y
-- auditoría directamente asociada a esos módulos.
--
-- Preserva explícitamente: profiles/auth, categorias, site_settings,
-- site_banners*, customer_credit_* (saldo de clientes, no depende de un
-- pedido concreto: su columna order_id/claim_id es ON DELETE SET NULL, así
-- que queda intacto y sólo pierde la referencia al pedido de prueba
-- eliminado), admin_notification_reads, blocked_client_identifiers,
-- client_presence, customer_notification_campaigns.
--
-- Toda la operación corre en una única transacción (la migración completa)
-- para que los constraint triggers diferidos de estado comercial
-- (validate_product_commercial_state, validate_variant_commercial_state,
-- validate_variant_allocation_commercial_state) evalúen contra el estado
-- final ya vacío y no bloqueen el reset.
--
-- El "where true" es necesario: la base tiene una protección que exige
-- WHERE explícito en todo DELETE (bloquea "DELETE FROM tabla;" sin filtro).
--
-- Antes de borrar variantes/productos se recalcula el stock derivado a
-- mano: quitar una fila de inventory_variant_allocations no dispara por sí
-- sola refresh_inventory_stock, y el guardia antes-de-borrar de variantes
-- (guard_product_variant_delete) exige que el stock ya esté en cero.
--
-- Repetible: cada DELETE sobre una tabla ya vacía es un no-op, y recalcular
-- el stock de una tabla de productos vacía tampoco hace nada.

do $$
declare
  v_product_id bigint;
begin
  -- 1) Sublibros de inventario que referencian compras/ventas/devoluciones
  --    con RESTRICT hacia pedidos, productos y variantes.
  delete from public.inventory_return_movements where true;
  delete from public.product_cost_entries where true;
  delete from public.business_expenses where true;
  delete from public.mercadolibre_sales where true;
  delete from public.external_sales where true;

  -- 2) Notas de crédito de pedidos (RESTRICT hacia orden_items/ordenes).
  delete from public.order_credit_note_items where true;
  delete from public.order_credit_notes where true;

  -- 3) Reclamos de pedidos.
  delete from public.order_claim_files where true;
  delete from public.order_claim_messages where true;
  delete from public.order_claims where true;

  -- 4) Notificaciones y reservas comerciales dependientes de pedidos.
  delete from public.customer_notifications where true;
  delete from public.stock_reservations where true;

  -- 5) Pedidos.
  delete from public.orden_items where true;
  delete from public.ordenes where true;

  -- 6) Reseñas y favoritos de producto.
  delete from public.reviews where true;
  delete from public.resenas where true;
  delete from public.product_favorites where true;

  -- 7) Sublibros de catálogo/inventario de producto.
  delete from public.catalog_sku_registry where true;
  delete from public.inventory_variant_allocations where true;
  delete from public.inventory_opening_balances where true;
  delete from public.product_bulk_events where true;

  -- 8) Historial inmutable de operaciones de inventario: se deshabilita el
  --    guardia de inmutabilidad únicamente durante este reset controlado y
  --    se reactiva antes de continuar; no queda deshabilitado.
  alter table public.inventory_operation_log
    disable trigger prevent_inventory_operation_log_mutation;
  delete from public.inventory_operation_log where true;
  alter table public.inventory_operation_log
    enable trigger prevent_inventory_operation_log_mutation;

  -- 9) Especificaciones e imágenes de producto.
  delete from public.producto_especificaciones where true;
  delete from public.imagenes_producto where true;

  -- 10) Recalcula el stock derivado antes de borrar variantes/productos.
  for v_product_id in select id from public.productos loop
    perform public.refresh_inventory_stock(v_product_id);
  end loop;

  -- 11) Variantes y productos.
  delete from public.producto_variantes where true;
  delete from public.productos where true;

  -- 12) Auditoría generada directamente por los módulos anteriores. No se
  --     toca audit_logs de otros dominios (por ejemplo categorías).
  delete from public.audit_logs
  where table_name in (
    'productos',
    'producto_variantes',
    'orden_items',
    'ordenes',
    'product_cost_entries',
    'business_expenses',
    'mercadolibre_sales',
    'external_sales',
    'inventory_return_movements',
    'imagenes_producto'
  );
end;
$$;
