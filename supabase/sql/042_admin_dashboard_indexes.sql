create index if not exists ordenes_created_at_idx
  on public.ordenes (created_at desc);

create index if not exists ordenes_estado_idx
  on public.ordenes (estado);

create index if not exists ordenes_payment_status_idx
  on public.ordenes (payment_status);

create index if not exists ordenes_payment_method_status_idx
  on public.ordenes (payment_method_id, payment_status);

create index if not exists ordenes_invoice_status_idx
  on public.ordenes (invoice_status);

create index if not exists ordenes_paid_at_idx
  on public.ordenes (paid_at desc);

create index if not exists orden_items_orden_id_idx
  on public.orden_items (orden_id);

create index if not exists orden_items_producto_id_idx
  on public.orden_items (producto_id);

create index if not exists productos_activo_stock_idx
  on public.productos (activo, stock);

create index if not exists producto_variantes_activo_stock_idx
  on public.producto_variantes (activo, stock);

create index if not exists mercadolibre_sales_sale_date_idx
  on public.mercadolibre_sales (sale_date desc);
