-- BEYONIX: limpieza manual y conservadora de datos transaccionales de prueba.
--
-- IMPORTANTE
-- - Este archivo NO es una migración y no debe moverse a supabase/migrations/.
-- - No usa TRUNCATE, CASCADE ni descubrimiento dinámico de tablas.
-- - No reinicia identities.
-- - No toca auth.users, public.profiles ni las tablas maestras/de catálogo.
-- - Si una eliminación alterase el stock proyectado o la cantidad de filas
--   preservadas, una excepción revierte la transacción completa.
-- - Antes de usarlo en un proyecto con datos reales, restaurar/validar primero
--   cualquier información ya perdida y obtener un backup nuevo del estado actual.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- Barrera contra ejecuciones accidentales. Para ejecutar deliberadamente,
-- descomentar exactamente la línea siguiente en la misma sesión/transacción.
-- SET LOCAL beyonix.confirm_test_cleanup = 'BORRAR_SOLO_TRANSACCIONES_DE_PRUEBA';

DO $guard$
BEGIN
  IF current_setting('beyonix.confirm_test_cleanup', true)
       IS DISTINCT FROM 'BORRAR_SOLO_TRANSACCIONES_DE_PRUEBA' THEN
    RAISE EXCEPTION
      'Limpieza cancelada: falta la confirmación beyonix.confirm_test_cleanup.';
  END IF;
END
$guard$;

-- Evita que una escritura concurrente invalide las comprobaciones de seguridad.
-- SHARE ROW EXCLUSIVE permite lecturas normales y bloquea escrituras simultáneas.
LOCK TABLE
  public.productos,
  public.categorias,
  public.producto_variantes,
  public.imagenes_producto,
  public.producto_especificaciones,
  public.catalog_sku_registry,
  public.catalog_barcode_registry,
  public.product_cost_entries,
  public.inventory_opening_balances,
  public.inventory_variant_allocations,
  public.inventory_stock_adjustments,
  public.inventory_operation_log,
  public.inventory_return_movements,
  public.business_expenses,
  public.external_sales,
  public.mercadolibre_sales,
  public.product_bulk_events,
  public.product_favorites,
  public.resenas,
  public.reviews,
  public.site_settings,
  public.site_banners,
  public.site_banner_items,
  public.customer_notification_campaigns,
  public.customer_credit_movements,
  public.customer_credit_topups,
  public.customer_gift_cards,
  public.customer_store_benefits,
  public.blocked_client_identifiers,
  public.admin_notification_reads,
  public.admin_events,
  public.profiles,
  public.stock_reservations,
  public.order_credit_note_items,
  public.order_credit_notes,
  public.order_claim_files,
  public.order_claim_messages,
  public.order_refund_proofs,
  public.order_audit_events,
  public.order_claims,
  public.admin_order_views,
  public.customer_notifications,
  public.orden_items,
  public.ordenes,
  public.client_carts,
  public.client_presence,
  public.audit_logs
IN SHARE ROW EXCLUSIVE MODE;

-- Foto exacta de las proyecciones de stock antes de limpiar.
CREATE TEMP TABLE _beyonix_product_stock_before
ON COMMIT DROP
AS
SELECT id, stock
FROM public.productos;

CREATE TEMP TABLE _beyonix_variant_stock_before
ON COMMIT DROP
AS
SELECT id, producto_id, stock
FROM public.producto_variantes;

-- Conteos de todas las tablas que esta herramienta debe preservar. La lista es
-- intencionalmente explícita; no consulta pg_catalog para descubrir tablas.
CREATE TEMP TABLE _beyonix_preserved_counts_before (
  entity text PRIMARY KEY,
  row_count bigint NOT NULL
) ON COMMIT DROP;

INSERT INTO _beyonix_preserved_counts_before (entity, row_count)
VALUES
  ('profiles', (SELECT count(*) FROM public.profiles)),
  ('categorias', (SELECT count(*) FROM public.categorias)),
  ('productos', (SELECT count(*) FROM public.productos)),
  ('producto_variantes', (SELECT count(*) FROM public.producto_variantes)),
  ('imagenes_producto', (SELECT count(*) FROM public.imagenes_producto)),
  ('producto_especificaciones', (SELECT count(*) FROM public.producto_especificaciones)),
  ('catalog_sku_registry', (SELECT count(*) FROM public.catalog_sku_registry)),
  ('catalog_barcode_registry', (SELECT count(*) FROM public.catalog_barcode_registry)),
  ('product_cost_entries', (SELECT count(*) FROM public.product_cost_entries)),
  ('inventory_opening_balances', (SELECT count(*) FROM public.inventory_opening_balances)),
  ('inventory_variant_allocations', (SELECT count(*) FROM public.inventory_variant_allocations)),
  ('inventory_stock_adjustments', (SELECT count(*) FROM public.inventory_stock_adjustments)),
  ('inventory_operation_log', (SELECT count(*) FROM public.inventory_operation_log)),
  ('inventory_return_movements', (SELECT count(*) FROM public.inventory_return_movements)),
  ('business_expenses', (SELECT count(*) FROM public.business_expenses)),
  ('external_sales', (SELECT count(*) FROM public.external_sales)),
  ('mercadolibre_sales', (SELECT count(*) FROM public.mercadolibre_sales)),
  ('product_bulk_events', (SELECT count(*) FROM public.product_bulk_events)),
  ('product_favorites', (SELECT count(*) FROM public.product_favorites)),
  ('resenas', (SELECT count(*) FROM public.resenas)),
  ('reviews', (SELECT count(*) FROM public.reviews)),
  ('site_settings', (SELECT count(*) FROM public.site_settings)),
  ('site_banners', (SELECT count(*) FROM public.site_banners)),
  ('site_banner_items', (SELECT count(*) FROM public.site_banner_items)),
  ('customer_notification_campaigns', (SELECT count(*) FROM public.customer_notification_campaigns)),
  ('customer_credit_movements', (SELECT count(*) FROM public.customer_credit_movements)),
  ('customer_credit_topups', (SELECT count(*) FROM public.customer_credit_topups)),
  ('customer_gift_cards', (SELECT count(*) FROM public.customer_gift_cards)),
  ('customer_store_benefits', (SELECT count(*) FROM public.customer_store_benefits)),
  ('blocked_client_identifiers', (SELECT count(*) FROM public.blocked_client_identifiers)),
  ('admin_notification_reads', (SELECT count(*) FROM public.admin_notification_reads)),
  ('admin_events', (SELECT count(*) FROM public.admin_events));

-- No se eliminan devoluciones porque son entradas de stock y además pueden
-- sostener ofertas de productos con condición. Si una depende de un pedido que
-- se pretende borrar, no existe una limpieza segura automática: se cancela todo.
-- Tampoco se borran reseñas verificadas junto con sus pedidos: son catálogo.
DO $preflight$
BEGIN
  -- El esquema no posee un marcador is_test confiable. Un comprobante fiscal
  -- autorizado nunca se presume de prueba sólo por estar en esta base.
  IF EXISTS (
    SELECT 1
    FROM public.ordenes
    WHERE invoice_status = 'authorized'
       OR invoice_cae IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'Limpieza cancelada: existen facturas autorizadas. Seleccione IDs de prueba de forma explícita; no se borran automáticamente.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.order_credit_notes
    WHERE status = 'authorized'
       OR cae IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'Limpieza cancelada: existen notas de crédito autorizadas. Seleccione IDs de prueba de forma explícita; no se borran automáticamente.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.inventory_return_movements
    WHERE order_id IS NOT NULL OR order_item_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'Limpieza cancelada: existen devoluciones enlazadas a pedidos. Deben reconciliarse sin borrar su movimiento de stock.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.reviews
    WHERE order_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'Limpieza cancelada: existen reseñas verificadas enlazadas a pedidos. Borrarlos alteraría el catálogo.';
  END IF;
END
$preflight$;

-- Hijos de pedidos/reclamos/notas de crédito, en orden de claves foráneas.
DELETE FROM public.stock_reservations
WHERE true;

DELETE FROM public.order_credit_note_items
WHERE true;

DELETE FROM public.order_credit_notes
WHERE true;

DELETE FROM public.order_claim_files
WHERE true;

DELETE FROM public.order_claim_messages
WHERE true;

DELETE FROM public.order_refund_proofs
WHERE true;

DELETE FROM public.order_audit_events
WHERE true;

DELETE FROM public.order_claims
WHERE true;

DELETE FROM public.admin_order_views
WHERE true;

-- Se preservan las notificaciones generales/campañas; sólo se quitan las que
-- fueron generadas para un pedido.
DELETE FROM public.customer_notifications
WHERE order_id IS NOT NULL;

DELETE FROM public.orden_items
WHERE true;

DELETE FROM public.ordenes
WHERE true;

-- Estado efímero del storefront.
DELETE FROM public.client_carts
WHERE true;

DELETE FROM public.client_presence
WHERE true;

-- Sólo auditoría inequívocamente asociada a las entidades eliminadas.
DELETE FROM public.audit_logs
WHERE table_name IN (
  'ordenes',
  'orden_items',
  'order_claims',
  'order_claim_messages',
  'order_claim_files',
  'order_credit_notes',
  'order_credit_note_items',
  'order_refund_proofs',
  'order_audit_events',
  'stock_reservations',
  'client_carts',
  'client_presence'
);

-- Invariante principal: ni un producto/variante puede desaparecer, aparecer o
-- cambiar de stock. Cualquier trigger o dependencia no contemplada hace ROLLBACK.
DO $stock_invariants$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM _beyonix_product_stock_before AS old
    FULL JOIN public.productos AS current USING (id)
    WHERE old.id IS NULL
       OR current.id IS NULL
       OR old.stock IS DISTINCT FROM current.stock
  ) THEN
    RAISE EXCEPTION
      'Limpieza revertida: cambió el stock o el conjunto de productos.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM _beyonix_variant_stock_before AS old
    FULL JOIN public.producto_variantes AS current USING (id)
    WHERE old.id IS NULL
       OR current.id IS NULL
       OR old.producto_id IS DISTINCT FROM current.producto_id
       OR old.stock IS DISTINCT FROM current.stock
  ) THEN
    RAISE EXCEPTION
      'Limpieza revertida: cambió el stock o el conjunto de variantes.';
  END IF;
END
$stock_invariants$;

-- Segunda barrera: ninguna tabla preservada puede perder ni ganar filas.
DO $preserved_count_invariants$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM _beyonix_preserved_counts_before AS old
    JOIN (
      SELECT 'profiles' AS entity, count(*) AS row_count FROM public.profiles
      UNION ALL SELECT 'categorias', count(*) FROM public.categorias
      UNION ALL SELECT 'productos', count(*) FROM public.productos
      UNION ALL SELECT 'producto_variantes', count(*) FROM public.producto_variantes
      UNION ALL SELECT 'imagenes_producto', count(*) FROM public.imagenes_producto
      UNION ALL SELECT 'producto_especificaciones', count(*) FROM public.producto_especificaciones
      UNION ALL SELECT 'catalog_sku_registry', count(*) FROM public.catalog_sku_registry
      UNION ALL SELECT 'catalog_barcode_registry', count(*) FROM public.catalog_barcode_registry
      UNION ALL SELECT 'product_cost_entries', count(*) FROM public.product_cost_entries
      UNION ALL SELECT 'inventory_opening_balances', count(*) FROM public.inventory_opening_balances
      UNION ALL SELECT 'inventory_variant_allocations', count(*) FROM public.inventory_variant_allocations
      UNION ALL SELECT 'inventory_stock_adjustments', count(*) FROM public.inventory_stock_adjustments
      UNION ALL SELECT 'inventory_operation_log', count(*) FROM public.inventory_operation_log
      UNION ALL SELECT 'inventory_return_movements', count(*) FROM public.inventory_return_movements
      UNION ALL SELECT 'business_expenses', count(*) FROM public.business_expenses
      UNION ALL SELECT 'external_sales', count(*) FROM public.external_sales
      UNION ALL SELECT 'mercadolibre_sales', count(*) FROM public.mercadolibre_sales
      UNION ALL SELECT 'product_bulk_events', count(*) FROM public.product_bulk_events
      UNION ALL SELECT 'product_favorites', count(*) FROM public.product_favorites
      UNION ALL SELECT 'resenas', count(*) FROM public.resenas
      UNION ALL SELECT 'reviews', count(*) FROM public.reviews
      UNION ALL SELECT 'site_settings', count(*) FROM public.site_settings
      UNION ALL SELECT 'site_banners', count(*) FROM public.site_banners
      UNION ALL SELECT 'site_banner_items', count(*) FROM public.site_banner_items
      UNION ALL SELECT 'customer_notification_campaigns', count(*) FROM public.customer_notification_campaigns
      UNION ALL SELECT 'customer_credit_movements', count(*) FROM public.customer_credit_movements
      UNION ALL SELECT 'customer_credit_topups', count(*) FROM public.customer_credit_topups
      UNION ALL SELECT 'customer_gift_cards', count(*) FROM public.customer_gift_cards
      UNION ALL SELECT 'customer_store_benefits', count(*) FROM public.customer_store_benefits
      UNION ALL SELECT 'blocked_client_identifiers', count(*) FROM public.blocked_client_identifiers
      UNION ALL SELECT 'admin_notification_reads', count(*) FROM public.admin_notification_reads
      UNION ALL SELECT 'admin_events', count(*) FROM public.admin_events
    ) AS current USING (entity)
    WHERE old.row_count IS DISTINCT FROM current.row_count
  ) THEN
    RAISE EXCEPTION
      'Limpieza revertida: cambió la cantidad de filas de una tabla preservada.';
  END IF;
END
$preserved_count_invariants$;

-- No se ejecuta ALTER SEQUENCE/RESTART IDENTITY: conservar los contadores evita
-- reutilizar identificadores que puedan existir en sistemas o comprobantes externos.
COMMIT;
