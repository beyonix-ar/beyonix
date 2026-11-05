import { readFileSync } from "node:fs"
import { join } from "node:path"

import { missingMigrationCGuardFunctionStubsSql } from "./migration-c-guard-stubs.ts"

// Base para los tests del resultado de entrega Envío BEYONIX (QR del cadete,
// retorno local y reserva): las migraciones reales del circuito de Despachos +
// A, B, C y la migración nueva, sobre los fixtures parciales de siempre.

export const LOCAL_DELIVERY_OUTCOME_MIGRATION = "supabase/migrations/20261105120000_local_delivery_outcomes_and_returns.sql"

export const LOCAL_DELIVERY_OUTCOME_BASE_FILES = [
  "lib/orders/fixtures/dispatch-schema.sql",
  "supabase/migrations/20260820120000_cost_catalog_barcode.sql",
  "supabase/migrations/20261005100000_dispatch_operations.sql",
  "supabase/migrations/20261005110000_dispatch_guards.sql",
  "supabase/migrations/20261007100000_barcodes_parcels_dispatch.sql",
  "lib/orders/fixtures/dispatch-inventory-schema.sql",
  "supabase/migrations/20261008120000_catalog_random_dual_color_barcode_aliases.sql",
  "supabase/migrations/20261009100000_random_fulfillment_traceability.sql",
  "supabase/migrations/20260918110000_inventory_refresh_reproducibility.sql",
  "supabase/migrations/20260918100000_refresh_inventory_stock_fail_closed.sql",
  "supabase/migrations/20261016100000_dispatch_cancellation_physical_holds.sql",
  "supabase/migrations/20261016101000_dispatch_hold_check_public_catalog.sql",
  "supabase/migrations/20261016110000_dispatch_hold_from_first_pick.sql",
  "supabase/migrations/20261016120000_cancellation_after_picking_manual_refund.sql",
  "supabase/migrations/20261016130000_picked_cancellation_admin_refund_only.sql",
  "supabase/migrations/20261016150000_dispatch_general_bundle_verification.sql",
  "supabase/migrations/20261016160000_dispatch_andreani_identification.sql",
  "supabase/migrations/20261017100000_dispatch_finalize_on_verification.sql",
  "supabase/migrations/20261017110000_super_admin_force_cancellation.sql",
  "supabase/migrations/20261021100000_dispatch_andreani_label_scan_confirmation.sql",
  "supabase/migrations/20261103120000_local_delivery_parcels_labels.sql",
  "supabase/migrations/20261103130000_local_delivery_in_transit_parcels_guard.sql",
]

export const MIGRATION_C = "supabase/migrations/20261104120000_local_delivery_change_guard_and_label_generation.sql"

/** Columnas que los fixtures parciales no tienen y la base real sí. */
export const FIXTURE_EXTRA_COLUMNS_SQL = `
  alter table ordenes add column andreani_tracking text;
  alter table ordenes add column delivered_at timestamptz;
  alter table ordenes add column credit_note_required boolean default false;
  alter table ordenes add column invoice_number integer;
  alter table ordenes add column invoice_point integer;
  alter table ordenes add column cancellation_requested_by uuid;
  alter table orden_items add column precio numeric default 1000;
`

// Ventas externas con ciclo de vida (20261027210000): el libro de inventario
// que redefine la migración nueva las referencia. Sólo lo que la vista usa.
export const EXTERNAL_SALES_LIFECYCLE_STUB_SQL = `
  alter table external_sales add column stock_effect text not null default 'consume';
  alter table external_sales add column reversal_kind text;
  alter table external_sales add column return_condition text;
  create function public.external_sale_consumes_stock(p_effect text, p_status text, p_reversal text, p_condition text)
    returns boolean language sql immutable as $$ select p_effect = 'consume' and coalesce(p_status, 'active') = 'active' $$;
`

export const readRepoFile = (path: string) => readFileSync(join(process.cwd(), path), "utf8")

/** Todo el SQL, en orden, para dejar una base lista con la migración nueva aplicada. */
export function localDeliveryOutcomeSetupSql(read: (path: string) => string = readRepoFile) {
  const parts: string[] = []
  for (const file of LOCAL_DELIVERY_OUTCOME_BASE_FILES) {
    parts.push(read(file))
    if (file.endsWith("dispatch-schema.sql")) parts.push(FIXTURE_EXTRA_COLUMNS_SQL)
    if (file.endsWith("dispatch-inventory-schema.sql")) parts.push("alter table order_credit_notes add column total_amount numeric default 0;")
  }
  parts.push(missingMigrationCGuardFunctionStubsSql())
  parts.push(read(MIGRATION_C))
  parts.push(EXTERNAL_SALES_LIFECYCLE_STUB_SQL)
  parts.push(read(LOCAL_DELIVERY_OUTCOME_MIGRATION))
  return parts
}

export const OUTCOME_ACTOR = "20000000-0000-4000-8000-000000000002"
export const OUTCOME_CUSTOMER = "30000000-0000-4000-8000-000000000003"
export const LOCAL_ORDER = 1041
export const LOCAL_SINGLE = 1042
export const ANDREANI_ORDER = 1043

/** Datos: productos con stock, un pedido local de 2 bultos, uno de 1 bulto y uno Andreani. */
export const OUTCOME_SEED_SQL = `
  insert into profiles(id,rol) values ('${OUTCOME_ACTOR}','operador'),('${OUTCOME_CUSTOMER}','cliente');
  insert into productos(id,sku,codigo_barra,nombre) values (1,'SKU-A','BAR-A','Auriculares Pro'),(2,'SKU-B','BAR-B','Ñandú lámpara');
  insert into producto_variantes(id,producto_id,sku,codigo_barra,nombre) values (11,1,'SKU-A-RED','BAR-A-RED','Rojo'),(12,1,'SKU-A-BLUE','BAR-A-BLUE','Azul');
  insert into catalog_sku_registry(normalized_sku,product_id,variant_id) values ('SKU-A',1,null),('SKU-B',2,null),('SKU-A-RED',null,11),('SKU-A-BLUE',null,12);
  insert into product_cost_entries(product_id,variant_id,received_quantity) values (1,11,10),(1,12,10),(2,null,10);
  insert into ordenes(id,shipping_provider,andreani_envio_id,andreani_creation_status,andreani_tracking) values
    (${LOCAL_ORDER},'beyonix',null,null,null),
    (${LOCAL_SINGLE},'beyonix',null,null,null),
    (${ANDREANI_ORDER},'andreani','ENV-1043','created','360000001043');
  insert into orden_items(id,orden_id,producto_id,variante_id,cantidad) values
    (1,${LOCAL_ORDER},1,11,2),(2,${LOCAL_ORDER},2,null,1),(3,${LOCAL_SINGLE},1,12,1),(4,${ANDREANI_ORDER},1,12,1);
  select refresh_inventory_stock(1); select refresh_inventory_stock(2);
`

export const OUTCOME_PICK_CODES: Record<number, string[]> = {
  [LOCAL_ORDER]: ["BAR-A-RED", "BAR-A-RED", "BAR-B"],
  [LOCAL_SINGLE]: ["BAR-A-BLUE"],
  [ANDREANI_ORDER]: ["BAR-A-BLUE"],
}

/** Token válido de prueba (base64url, 22+ caracteres). */
export const outcomeToken = (orderId: number) => `tok${orderId}AbCdEfGhIjKlMnOpQrStUv`
