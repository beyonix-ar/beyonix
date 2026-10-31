import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

import { buildSaleFinancials } from "../business/commercial-sale-financials.ts"
import { buildMercadoLibreWorkbook, saleRow, type FixtureRow } from "./fixtures/ml-report-fixture.ts"
import { getMercadoLibreSaleIdentity } from "./import-integrity.ts"
import { validateMercadoLibreServerRows } from "./import-validation.ts"
import { buildMercadoLibreMatchingContext, getListingVariantKey, type ProductChannelMapping } from "./product-matching.ts"
import { buildMercadoLibreImportPayload, getPreservedCostMapping, type PreservedCostMapping } from "./product-matching-server.ts"
import { getMercadoLibreCostableUnits, getMercadoLibreCostMapping, getMercadoLibreRefundAmount } from "./sale-costing.ts"
import { parseMercadoLibreSalesReport } from "./sales-report.ts"
import { buildUniqueCatalogTargetsBySku, type CatalogSkuRow } from "./sku-reconciliation.ts"

// Importación ML contra las migraciones reales y el libro de inventario
// derivado (inventory_movements + refresh_inventory_stock): una importación
// histórica nunca toca el stock actual; una de ventas actuales sí.

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8").replace(/\r\n/g, "\n")
const ACTOR = "10000000-0000-4000-8000-000000000001"

const SETUP_MIGRATIONS = [
  "supabase/migrations/20260801100000_inventory_sale_write_guards.sql",
  "supabase/migrations/20260918100000_refresh_inventory_stock_fail_closed.sql",
  "supabase/migrations/20260918150000_purchase_inventory_refresh_reproducibility.sql",
  "supabase/migrations/20260921100000_external_sale_reversal.sql",
  "supabase/migrations/20260923110000_external_sale_creation_and_write_guards.sql",
  "supabase/migrations/20261027210000_external_sales_imports_and_lifecycle.sql",
  "supabase/migrations/20260801090000_idempotent_mercadolibre_import.sql",
  "supabase/migrations/20261015100000_mercadolibre_import_batches.sql",
  "supabase/migrations/20261031150000_mercadolibre_historical_import_and_product_mappings.sql",
]

async function setup() {
  const db = new PGlite()
  await db.exec(read("lib/business/fixtures/external-sales-schema.sql"))
  // Columnas reales de mercadolibre_sales / devoluciones que el fixture compartido no trae.
  await db.exec(`
    alter table public.mercadolibre_sales
      add column gross_amount numeric(12,2) not null default 0,
      add column fee_amount numeric(12,2), add column shipping_amount numeric(12,2),
      add column net_amount numeric(12,2), add column source_file_name text,
      add column unit_cost numeric(12,2) not null default 0;
    alter table public.mercadolibre_sales alter column raw_data set default '{}'::jsonb;
    alter table public.inventory_return_movements add column received_quantity integer not null default 0;
    -- Firmas y definiciones reales (baseline de producción); la migración
    -- nueva reemplaza inventory_ml_stock_units.
    drop function public.inventory_ml_variant_id(jsonb);
    drop function public.inventory_ml_stock_units(integer, jsonb);
    create function public.inventory_ml_variant_id(p_raw_data jsonb) returns bigint
      language sql immutable as $$
        select case when coalesce(p_raw_data #>> '{beyonix_cost_mapping,variant_id}', '') ~ '^[1-9][0-9]*$'
          then (p_raw_data #>> '{beyonix_cost_mapping,variant_id}')::bigint end $$;
    create function public.inventory_ml_stock_units(p_quantity integer, p_raw_data jsonb) returns integer
      language plpgsql immutable as $$
      begin
        if lower(coalesce(p_raw_data -> 'parsed' ->> 'status', '')) ~ '(cancel|anulad)' then return 0; end if;
        return greatest(coalesce(p_quantity, 0), 0);
      end $$;
  `)
  for (const file of SETUP_MIGRATIONS) await db.exec(read(file))
  await db.exec(`
    insert into auth.users values ('${ACTOR}');
    insert into public.profiles values ('${ACTOR}', 'admin', 'admin@beyonix.test');
    insert into public.productos (id, nombre, sku) values
      (10, 'Apoyabrazos Ergonómico', 'AP01'), (20, 'Mate Térmico 236', null),
      (30, 'Auriculares Malibú', null), (40, 'Producto con SKU nuevo', null);
    insert into public.producto_variantes (id, producto_id, nombre, sku) values
      (201, 20, 'Negro', 'MTN01'), (202, 20, 'Rosa', 'MATE-ROSA'), (203, 20, 'Verde', 'MATE-VERDE'),
      (301, 30, 'Verde', 'MALIBU-VER'), (302, 30, 'Negro', 'MALIBU-NEG'), (401, 40, 'Única', 'NEW-SKU');
    insert into public.product_cost_entries (product_id, variant_id, sku, purchase_date, received_quantity) values
      (10, null, 'AP01', '2026-01-01', 20), (20, 201, 'MTN01', '2026-01-01', 5), (20, 202, 'MATE-ROSA', '2026-01-01', 4),
      (20, 203, 'MATE-VERDE', '2026-01-01', 3), (30, 301, 'MALIBU-VER', '2026-01-01', 6),
      (30, 302, 'MALIBU-NEG', '2026-01-01', 7), (40, 401, 'NEW-SKU', '2026-01-01', 8);
    select public.refresh_inventory_stock(id) from public.productos;
  `)
  return db
}

/** Las 11 líneas del reporte del 31/10/2026 (importes reales, sin datos del comprador). */
const AUDITED_LINES: FixtureRow[] = [
  ["2000015526666809", "14 de octubre de 2026 17:43 hs.", "Entregado", "Sí", 1, 27434, -4020.99, -3340, 0, 0, -9506, 0, 10567.01, "MTN01", "MLA3106141198", "Color : Negro"],
  ["2000015493903389", "12 de octubre de 2026 21:09 hs.", "Entregado", "Sí", 1, 27900, -4089.29, -3340, 0, 0, -9506, 0, 10964.71, "MTN01", "MLA3106141198", "Color : Negro"],
  ["2000015315550973", "2 de octubre de 2026 12:09 hs.", "Entregado", "Sí", 1, 33000, -5224.41, 0, -4422, 0, -7790, 0, 15563.59, "AURIVINEXTMALIBUVER", "MLA3976733502", "Color : Verde"],
  ["2000015049400393", "15 de septiembre de 2026 16:57 hs.", "Entregado", "Sí", 1, 33000, -5224.41, 0, -4422, 0, -7790, 0, 15563.59, "AURIVINEXTMALIBUNEG", "MLA1729479731", "Color : Negro"],
  ["2000013124300627", "22 de mayo de 2026 22:53 hs.", "Entregado", "Sí", 2, 52350, -7753.12, -5900, 0, 0, 0, 0, 38696.88, "AP01", "MLA3268194664", "Color : Negro"],
  ["2000016427300948", "14 de mayo de 2026 04:44 hs.", "Entregado", "No", 1, 27920, -4135, -2950, 0, 11220, -11220, 0, 20835, "AP01", "MLA3268194664", "Color : Negro"],
  ["2000012959153625", "13 de mayo de 2026 09:52 hs.", "Entregado", "Sí", 1, 22320, -3271.43, -2465, 0, 0, -8596, 0, 7987.57, "MATEINOXROSA001", "MLA3106141198", "Color : Rosa"],
  ["2000012958302463", "13 de mayo de 2026 08:54 hs.", "Devolución finalizada con reembolso al comprador", "Sí", 2, 55840, -8270, -5900, 0, 5534.4, -5534.4, -41670, -16570, "AP01", "MLA3268194664", "Color : Negro"],
  ["2000012916031297", "10 de mayo de 2026 23:06 hs.", "Entregado", "Sí", 1, 34900, -5168.74, 0, 0, 0, -7230, 0, 22501.26, "AP01", "MLA3268194664", "Color : Negro"],
  ["2000012798861103", "4 de mayo de 2026 00:42 hs.", "Entregado", "Sí", 1, 28900, -4280.13, -2950, 0, 0, 0, 0, 21669.87, "AP01", "MLA3268194664", "Color : Negro"],
  ["2000015969450438", "13 de abril de 2026 19:55 hs.", "Entregado", "No", 1, 19900, -2916.73, -2500, 0, 0, 0, 0, 14483.27, "MATEINOXVERDE001", "MLA3106141198", "Color : Verde"],
].map(([sale_number, sale_date_text, status, multi_product_package, units, product_revenue, sale_fee, fixed_cost, installment_cost, shipping_income, shipping_cost, cancellations_refunds, total, sku, listing_id, variant]) =>
  saleRow({
    sale_number, sale_date_text, status, multi_product_package, units, product_revenue, sale_fee, fixed_cost,
    installment_cost, shipping_income, shipping_cost, taxes: 0, cancellations_refunds, total, sku, listing_id, variant,
    listing_title: `Publicación ${listing_id}`,
    // Reclamo cerrado = 1; la columna "Unidades" de devoluciones queda vacía.
    claim_closed: sale_number === "2000012958302463" ? "1" : null,
    buyer: null, buyer_state: null,
  }),
)

const RETURN_SALE = "2000012958302463"
const UNLINKED_SKUS = ["AURIVINEXTMALIBUVER", "AURIVINEXTMALIBUNEG", "MATEINOXROSA001", "MATEINOXVERDE001"]

function reportRows(lines: FixtureRow[]) {
  const report = parseMercadoLibreSalesReport(buildMercadoLibreWorkbook(lines), "ventas.xlsx")
  const validated = validateMercadoLibreServerRows(JSON.parse(JSON.stringify(report.rows)))
  assert.ok(validated.ok)
  return { report, rows: validated.rows }
}

type StoredSale = {
  id: string; operation_id: string; sku: string | null; product_id: number | null; quantity: number
  stock_effect: string; gross_amount: string; net_amount: string; fee_amount: string; shipping_amount: string
  sale_date: string; order_id: string; product_name: string; raw_data: Record<string, unknown>
}

async function sales(db: PGlite) {
  return (await db.query<StoredSale>("select * from public.mercadolibre_sales order by operation_id")).rows
}

async function stockSnapshot(db: PGlite) {
  const products = (await db.query<{ id: number; stock: number }>("select id, stock from public.productos order by id")).rows
  const variants = (await db.query<{ id: number; stock: number }>("select id, stock from public.producto_variantes order by id")).rows
  return Object.fromEntries([
    ...products.map((row) => [`p${row.id}`, Number(row.stock)]),
    ...variants.map((row) => [`v${row.id}`, Number(row.stock)]),
  ])
}

/** Mismo armado que la ruta /import: catálogo, vínculos activos y vínculos previos. */
async function payloadFor(db: PGlite, rows: ReturnType<typeof reportRows>["rows"]) {
  const products = (await db.query<{ id: number; sku: string | null }>("select id, sku from public.productos")).rows
  const variants = (await db.query<{ id: number; producto_id: number; sku: string | null }>("select id, producto_id, sku from public.producto_variantes")).rows
  const catalog: CatalogSkuRow[] = products.map((product) => ({
    id: Number(product.id),
    sku: product.sku,
    producto_variantes: variants.filter((variant) => Number(variant.producto_id) === Number(product.id)).map((variant) => ({ id: Number(variant.id), sku: variant.sku })),
  }))
  const mappings = (await db.query<ProductChannelMapping>(
    "select id, mapping_type, match_key, product_id::int as product_id, variant_id::int as variant_id, origin, valid_from::text as valid_from, valid_to::text as valid_to from public.product_channel_mappings where channel = 'mercadolibre' and active",
  )).rows
  const preservedByIdentity = new Map<string, PreservedCostMapping>()
  for (const sale of await sales(db)) {
    const preserved = getPreservedCostMapping({ ...sale, unit_cost: 0 })
    if (preserved) {
      const { operation_id, order_id, sale_date, product_name, sku, raw_data } = sale
      preservedByIdentity.set(getMercadoLibreSaleIdentity({ operation_id, order_id, sale_date, product_name, sku, raw_data }), preserved)
    }
  }
  const context = buildMercadoLibreMatchingContext({ catalogTargetsBySku: buildUniqueCatalogTargetsBySku(catalog), catalog, mappings })
  return buildMercadoLibreImportPayload(rows, { context, preservedByIdentity }, { actorId: ACTOR, mappedAt: "2026-10-31T18:00:00.000Z" })
}

async function newBatch(db: PGlite, mode: "historical" | "current") {
  return (await db.query<{ id: string }>(
    "insert into public.mercadolibre_import_batches (imported_by, source_file_name, import_mode) values ($1, 'ventas.xlsx', $2) returning id",
    [ACTOR, mode],
  )).rows[0].id
}

async function importRows(db: PGlite, batchId: string, payload: unknown[]) {
  return (await db.query<{ result: Record<string, number> }>(
    "select public.import_mercadolibre_sales_batch($1, $2::jsonb, $3) as result",
    [batchId, JSON.stringify(payload), ACTOR],
  )).rows[0].result
}

test("histórico: las 11 ventas auditadas se registran con finanzas y vínculos, sin tocar el stock", async () => {
  const db = await setup()
  try {
    const before = await stockSnapshot(db)
    assert.deepEqual(before, { p10: 20, p20: 12, p30: 13, p40: 8, v201: 5, v202: 4, v203: 3, v301: 6, v302: 7, v401: 8 })

    const { report, rows } = reportRows(AUDITED_LINES)
    assert.deepEqual(
      [report.rows.length, report.totals.operations, report.totals.gross, report.totals.net, report.totals.refunds],
      [11, 11, 363464, 162262.75, 41670],
    )

    const { payload, unlinked } = await payloadFor(db, rows)
    assert.equal(unlinked, 4, "los 4 SKU sin match quedan sin vincular: nunca por nombre")
    assert.deepEqual(
      payload.filter((row) => row.product_id == null).map((row) => row.sku).sort(),
      [...UNLINKED_SKUS].sort(),
    )

    const batch = await newBatch(db, "historical")
    assert.deepEqual(await importRows(db, batch, payload), { received: 11, inserted: 11, updated: 0, unchanged: 0, duplicate_rows: 0 })

    // Stock antes = después para TODOS los productos y variantes (AP01, MTN01,
    // la devolución y las líneas sin vínculo incluidas).
    assert.deepEqual(await stockSnapshot(db), before)
    const ledger = await db.query<{ count: number }>("select count(*)::int as count from public.inventory_movements where source = 'mercadolibre_sale'")
    assert.equal(ledger.rows[0].count, 0, "ninguna venta histórica entra al libro de inventario")
    await db.query("select public.refresh_inventory_stock(id) from public.productos")
    assert.deepEqual(await stockSnapshot(db), before, "un recálculo completo tampoco las descuenta")
    const reservations = await db.query<{ count: number }>("select count(*)::int as count from public.stock_reservations")
    assert.equal(reservations.rows[0].count, 0)

    const stored = await sales(db)
    assert.equal(stored.length, 11)
    assert.ok(stored.every((sale) => sale.stock_effect === "none" && sale.raw_data.beyonix_stock_effect === "none"))
    // Paquetes: cada línea con sus propios importes; nada se duplica.
    assert.equal(stored.reduce((total, sale) => total + Number(sale.gross_amount), 0), 363464)
    assert.equal(Math.round(stored.reduce((total, sale) => total + Number(sale.net_amount), 0) * 100) / 100, 162262.75)
    assert.equal(stored.reduce((total, sale) => total + getMercadoLibreRefundAmount(sale), 0), 41670)

    // Vínculos: AP01 y MTN01 por SKU exacto; el SKU original queda siempre.
    const ap01 = stored.filter((sale) => sale.sku === "AP01")
    assert.equal(ap01.length, 5)
    assert.ok(ap01.every((sale) => Number(sale.product_id) === 10 && (sale.raw_data.beyonix_cost_mapping as Record<string, unknown>).mapping_origin === "automatic_exact_sku"))
    const mtn01 = stored.filter((sale) => sale.sku === "MTN01")
    assert.ok(mtn01.every((sale) => getMercadoLibreCostMapping(sale)?.variant_id === 201))
    assert.deepEqual(stored.filter((sale) => sale.product_id == null).map((sale) => sale.sku).sort(), [...UNLINKED_SKUS].sort())

    // Devolución ambigua: 2 vendidas, físicas desconocidas, 2 costeables, un solo reembolso.
    const returned = stored.find((sale) => sale.operation_id === RETURN_SALE)!
    const parsed = returned.raw_data.parsed as Record<string, unknown>
    assert.equal(returned.quantity, 2)
    assert.equal(parsed.return_units, null, "la columna de unidades devueltas está vacía: desconocida")
    assert.equal(parsed.claim_closed, "1")
    assert.equal(getMercadoLibreCostableUnits(returned), 2)
    assert.equal(getMercadoLibreRefundAmount(returned), 41670)
    // El Total ML (−16.570) manda; la diferencia con los conceptos queda como otros costos.
    const financials = buildSaleFinancials({
      grossSales: Number(returned.gross_amount),
      reversalAmount: getMercadoLibreRefundAmount(returned),
      feeAmount: Number(returned.fee_amount),
      shippingCost: Number(returned.shipping_amount),
      reportedNetAmount: Number(returned.net_amount),
      costableUnits: 2,
      costAmount: null,
      costSource: "missing",
    })
    assert.equal(financials.netAmount, -16570)
    assert.equal(Math.round((financials.grossAmount! - financials.feeAmount - financials.shippingCost - financials.otherCosts) * 100) / 100, -16570)
    // Una venta histórica no admite reingreso físico: el stock ya lo refleja.
    await assert.rejects(
      db.query("insert into public.inventory_return_movements (mercadolibre_sale_id, product_id, sellable_quantity, received_quantity) values ($1, 10, 1, 1)", [returned.id]),
      /ML_HISTORICAL_SALE_RETURN/,
    )
    assert.deepEqual(await stockSnapshot(db), before)

    // El efecto sobre el stock no se puede cambiar ni falsear desde raw_data.
    await assert.rejects(db.query("update public.mercadolibre_sales set stock_effect = 'consume' where id = $1", [returned.id]), /ML_SALE_STOCK_EFFECT_IMMUTABLE/)
    await db.query("update public.mercadolibre_sales set raw_data = raw_data - 'beyonix_stock_effect' where id = $1", [returned.id])
    assert.equal((await sales(db)).find((sale) => sale.id === returned.id)!.raw_data.beyonix_stock_effect, "none")
    await assert.rejects(db.query("update public.mercadolibre_import_batches set import_mode = 'current' where id = $1", [batch]), /ML_IMPORT_MODE_IMMUTABLE/)
    await db.query("update public.mercadolibre_import_batches set status = 'completed' where id = $1", [batch])

    // Reimportación del mismo archivo: no duplica ni mueve stock.
    const again = await payloadFor(db, rows)
    const batchAgain = await newBatch(db, "historical")
    assert.deepEqual(await importRows(db, batchAgain, again.payload), { received: 11, inserted: 0, updated: 0, unchanged: 11, duplicate_rows: 0 })
    assert.equal((await sales(db)).length, 11)

    // Cambio de estado/reembolso: actualiza la misma línea, idempotente.
    const changedLines = AUDITED_LINES.map((line) =>
      line.sale_number === RETURN_SALE ? { ...line, return_units: 1, total: -16000 } : line,
    )
    const changed = await payloadFor(db, reportRows(changedLines).rows)
    const batchChanged = await newBatch(db, "historical")
    assert.deepEqual(await importRows(db, batchChanged, changed.payload), { received: 11, inserted: 0, updated: 1, unchanged: 10, duplicate_rows: 0 })
    const updatedReturn = (await sales(db)).find((sale) => sale.operation_id === RETURN_SALE)!
    assert.equal(updatedReturn.id, returned.id)
    assert.equal(Number(updatedReturn.net_amount), -16000)
    assert.equal(getMercadoLibreCostableUnits(updatedReturn), 1, "sólo una cantidad explícita recupera COGS")
    assert.equal(updatedReturn.stock_effect, "none")
    const batchRepeat = await newBatch(db, "historical")
    assert.equal((await importRows(db, batchRepeat, changed.payload)).unchanged, 11)

    // Reimportarlas como "ventas actuales" no las convierte: siguen sin mover stock.
    const batchCurrent = await newBatch(db, "current")
    await importRows(db, batchCurrent, (await payloadFor(db, reportRows(changedLines).rows)).payload)
    assert.ok((await sales(db)).every((sale) => sale.stock_effect === "none"))
    assert.deepEqual(await stockSnapshot(db), before)

    // B. Una venta nueva actual sigue descontando stock como siempre.
    const fresh = await payloadFor(db, reportRows([saleRow({ sale_number: "2000099999999999", sale_date_text: "31 de octubre de 2026 10:00 hs.", units: 2, sku: "AP01", listing_id: "MLA3268194664" })]).rows)
    await importRows(db, batchCurrent, fresh.payload)
    assert.deepEqual(await stockSnapshot(db), { ...before, p10: 18 })
    assert.equal((await sales(db)).find((sale) => sale.operation_id === "2000099999999999")!.stock_effect, "consume")
  } finally {
    await db.close()
  }
})

test("SKU histórico: OLD-SKU → variante actual NEW-SKU; vincula, conserva el SKU original y no mueve stock", async () => {
  const db = await setup()
  try {
    const before = await stockSnapshot(db)
    const line = saleRow({ sale_number: "2000011111111111", sale_date_text: "3 de marzo de 2026 10:00 hs.", units: 1, sku: "OLD-SKU", listing_id: "MLA4000000001", variant: null })
    assert.equal((await payloadFor(db, reportRows([line]).rows)).unlinked, 1, "sin alias no se vincula")

    await db.query(
      "insert into public.product_channel_mappings (channel, mapping_type, match_key, external_sku, product_id, variant_id, origin, created_by) values ('mercadolibre', 'sku_alias', 'OLD-SKU', 'OLD-SKU', 40, 401, 'manual_import_preview', $1)",
      [ACTOR],
    )
    const { payload, unlinked } = await payloadFor(db, reportRows([line]).rows)
    assert.equal(unlinked, 0)
    await importRows(db, await newBatch(db, "historical"), payload)

    const [sale] = await sales(db)
    assert.equal(sale.sku, "OLD-SKU", "la venta sigue registrando el SKU que informó Mercado Libre")
    assert.equal(Number(sale.product_id), 40)
    const mapping = sale.raw_data.beyonix_cost_mapping as Record<string, unknown>
    assert.equal(mapping.mapping_origin, "sku_alias")
    assert.equal(mapping.reported_sku, "OLD-SKU")
    // El COGS usa el producto/variante vinculado.
    assert.deepEqual(getMercadoLibreCostMapping(sale), { product_id: 40, variant_id: 401, standalone_key: null, match_key: "sku:OLD-SKU" })
    assert.equal(getMercadoLibreCostableUnits(sale), 1)
    assert.deepEqual(await stockSnapshot(db), before)

    // Integridad de los vínculos: un activo por clave y fecha, variante exacta, inmutables, auditados.
    await assert.rejects(
      db.query("insert into public.product_channel_mappings (channel, mapping_type, match_key, external_sku, product_id, variant_id) values ('mercadolibre', 'sku_alias', 'OLD-SKU', 'old-sku', 20, 202)"),
      /PRODUCT_MAPPING_OVERLAP/,
    )
    await assert.rejects(
      db.query("insert into public.product_channel_mappings (channel, mapping_type, match_key, external_sku, product_id) values ('mercadolibre', 'sku_alias', 'OTRO', 'OTRO', 20)"),
      /PRODUCT_MAPPING_VARIANT_REQUIRED/,
    )
    await assert.rejects(
      db.query("insert into public.product_channel_mappings (channel, mapping_type, match_key, listing_id, variant_label, product_id, variant_id) values ('mercadolibre', 'listing_variant', 'MLA1|', 'MLA1', '', 20, 202)"),
      /product_channel_mappings_shape_check/,
    )
    await assert.rejects(db.query("update public.product_channel_mappings set variant_id = 202, product_id = 20"), /PRODUCT_MAPPING_IMMUTABLE/)
    await db.query("update public.product_channel_mappings set active = false, deactivated_at = now(), deactivated_by = $1", [ACTOR])
    await db.query("insert into public.product_channel_mappings (channel, mapping_type, match_key, external_sku, product_id, variant_id) values ('mercadolibre', 'sku_alias', 'OLD-SKU', 'OLD-SKU', 20, 202)")
    const audit = await db.query<{ action: string }>("select action from public.audit_logs where table_name = 'product_channel_mappings' order by id")
    assert.deepEqual(audit.rows.map((row) => row.action), ["INSERT", "UPDATE", "INSERT"])
    // La venta ya importada conserva su imputación aunque el alias cambie.
    const reimport = await payloadFor(db, reportRows([line]).rows)
    assert.equal((reimport.payload[0].raw_data.beyonix_cost_mapping as Record<string, unknown>).variant_id, 401)

    const privileges = await db.query(`select
      has_table_privilege('authenticated', 'public.product_channel_mappings', 'SELECT') as auth_select,
      has_table_privilege('anon', 'public.product_channel_mappings', 'SELECT') as anon_select,
      has_table_privilege('service_role', 'public.product_channel_mappings', 'INSERT') as service_insert`)
    assert.deepEqual(privileges.rows[0], { auth_select: false, anon_select: false, service_insert: true })
  } finally {
    await db.close()
  }
})

test("vigencia en la base: dos alias del mismo SKU en períodos distintos, sin superposición", async () => {
  const db = await setup()
  try {
    const insert = (from: string | null, to: string | null, variant: number) =>
      db.query(
        "insert into public.product_channel_mappings (channel, mapping_type, match_key, external_sku, product_id, variant_id, valid_from, valid_to) values ('mercadolibre', 'sku_alias', 'REUSADO', 'REUSADO', 20, $1, $2, $3)",
        [variant, from, to],
      )
    await insert("2026-05-01", "2026-05-31", 202)
    await insert("2026-06-01", null, 203)
    await assert.rejects(insert("2026-05-31", "2026-06-15", 201), /PRODUCT_MAPPING_OVERLAP/, "los extremos son inclusivos")
    await assert.rejects(insert(null, null, 201), /PRODUCT_MAPPING_OVERLAP/)
    await assert.rejects(insert("2026-07-01", "2026-06-01", 201), /PRODUCT_MAPPING_INVALID_PERIOD/)
    await assert.rejects(db.query("update public.product_channel_mappings set valid_to = '2026-12-31'"), /PRODUCT_MAPPING_IMMUTABLE/)

    const line = (sale_number: string, sale_date_text: string) =>
      saleRow({ sale_number, sale_date_text, units: 1, sku: "REUSADO", listing_id: "MLA5000000001", variant: null })
    const { payload } = await payloadFor(db, reportRows([
      line("2000033333333331", "20 de abril de 2026 10:00 hs."),
      line("2000033333333332", "13 de mayo de 2026 10:00 hs."),
      line("2000033333333333", "31 de mayo de 2026 23:30 hs."),
      line("2000033333333334", "10 de julio de 2026 10:00 hs."),
    ]).rows)
    assert.deepEqual(
      payload.map((row) => (row.raw_data.beyonix_cost_mapping as { variant_id?: number } | undefined)?.variant_id ?? null),
      [null, 202, 202, 203],
      "antes de la vigencia no hay vínculo; cada período resuelve a su variante",
    )
  } finally {
    await db.close()
  }
})

test("publicación + variante: la base exige clave canónica y coherente", async () => {
  const db = await setup()
  try {
    const insert = (matchKey: string, listingId: string | null, variantLabel: string | null, externalSku: string | null = null) =>
      db.query(
        "insert into public.product_channel_mappings (channel, mapping_type, match_key, external_sku, listing_id, variant_label, product_id, variant_id) values ('mercadolibre', 'listing_variant', $1, $4, $2, $3, 20, 202)",
        [matchKey, listingId, variantLabel, externalSku],
      )
    // Publicación ABC, variante Negro, clave de Rosa: rechazado.
    await assert.rejects(insert("ABC|color:rosa", "ABC", "Color : Negro"), /product_channel_mappings_shape_check/)
    await assert.rejects(insert("MLA9|color:rosa", "MLA1", "Color : Rosa"), /product_channel_mappings_shape_check/, "otra publicación")
    await assert.rejects(insert("mla-1|color:rosa", "mla-1", "Color : Rosa"), /product_channel_mappings_shape_check/, "publicación no canónica")
    await assert.rejects(insert("MLA1|Color : Rosa", "MLA1", "Color : Rosa"), /product_channel_mappings_shape_check/, "variante no canónica")
    await assert.rejects(insert("MLA1|color:rosa", "MLA1", "Color : Rosa", "SKU-X"), /product_channel_mappings_shape_check/, "mezcla con alias de SKU")
    await assert.rejects(
      db.query("insert into public.product_channel_mappings (channel, mapping_type, match_key, external_sku, listing_id, product_id, variant_id) values ('mercadolibre', 'sku_alias', 'SKU-X', 'SKU-X', 'MLA1', 20, 202)"),
      /product_channel_mappings_shape_check/,
    )

    // La clave que calcula TypeScript coincide con la de la base, con tildes, ñ y espacios raros.
    for (const variant of ["Color : Rosa", "Diseño :  Ñandú Edición", "TALLE: XL "]) {
      const key = getListingVariantKey("MLA-777", variant)!
      await insert(key, "MLA777", variant)
      const stored = await db.query<{ key: string }>("select public.mercadolibre_variant_key($1) as key", [variant])
      assert.equal(`MLA777|${stored.rows[0].key}`, key)
    }
  } finally {
    await db.close()
  }
})

test("borrar producto o variante no borra el historial de vínculos y deja de resolver", async () => {
  const db = await setup()
  try {
    await db.query(`insert into public.product_channel_mappings (channel, mapping_type, match_key, external_sku, product_id, variant_id, created_by) values
      ('mercadolibre', 'sku_alias', 'VIEJO-ROSA', 'VIEJO-ROSA', 20, 202, $1),
      ('mercadolibre', 'sku_alias', 'VIEJO-NEG', 'VIEJO-NEG', 30, 302, $1),
      ('mercadolibre', 'sku_alias', 'VIEJO-VER', 'VIEJO-VER', 30, 301, $1)`, [ACTOR])
    // El destino original no se puede falsear al crear.
    const original = await db.query<{ original_product_id: number; original_variant_id: number }>(
      "select original_product_id::int, original_variant_id::int from public.product_channel_mappings where match_key = 'VIEJO-ROSA'",
    )
    assert.deepEqual(original.rows[0], { original_product_id: 20, original_variant_id: 202 })

    // Se borra una variante: el vínculo sigue, inactivo, con su destino original.
    await db.query("delete from public.producto_variantes where id = 202")
    // Se borra un producto entero (sus variantes primero).
    await db.query("delete from public.producto_variantes where producto_id = 30")
    await db.query("delete from public.productos where id = 30")

    const rows = await db.query<Record<string, unknown>>(
      "select match_key, product_id::int, variant_id::int, original_product_id::int, original_variant_id::int, active, deactivation_reason, deactivated_at is not null as deactivated from public.product_channel_mappings order by match_key",
    )
    assert.deepEqual(rows.rows, [
      { match_key: "VIEJO-NEG", product_id: null, variant_id: null, original_product_id: 30, original_variant_id: 302, active: false, deactivation_reason: "catalog_target_deleted", deactivated: true },
      { match_key: "VIEJO-ROSA", product_id: 20, variant_id: null, original_product_id: 20, original_variant_id: 202, active: false, deactivation_reason: "catalog_target_deleted", deactivated: true },
      { match_key: "VIEJO-VER", product_id: null, variant_id: null, original_product_id: 30, original_variant_id: 301, active: false, deactivation_reason: "catalog_target_deleted", deactivated: true },
    ])
    const audit = await db.query<{ count: number }>("select count(*)::int as count from public.audit_logs where table_name = 'product_channel_mappings' and action = 'DELETE'")
    assert.equal(audit.rows[0].count, 0, "nunca se borra físicamente")

    // Nuevas ventas con esos SKU quedan sin vincular: nunca apuntan a un destino inexistente.
    const lines = ["VIEJO-ROSA", "VIEJO-NEG"].map((sku, index) =>
      saleRow({ sale_number: `20000444444444${index}0`, sale_date_text: "3 de marzo de 2026 10:00 hs.", units: 1, sku, listing_id: "MLA6000000001", variant: null }),
    )
    assert.equal((await payloadFor(db, reportRows(lines).rows)).unlinked, 2)

    // El destino no se reasigna ni se reactiva.
    await assert.rejects(db.query("update public.product_channel_mappings set product_id = 20, variant_id = 203 where match_key = 'VIEJO-ROSA'"), /PRODUCT_MAPPING_IMMUTABLE|product_channel_mappings_target_check/)
    await assert.rejects(db.query("update public.product_channel_mappings set active = true, deactivated_at = null, deactivation_reason = null where match_key = 'VIEJO-ROSA'"), /PRODUCT_MAPPING_IMMUTABLE/)
  } finally {
    await db.close()
  }
})

test("publicación + variante: con varias variantes sólo el vínculo exacto resuelve", async () => {
  const db = await setup()
  try {
    const lines = ["Negro", "Rosa", "Verde"].map((color, index) =>
      saleRow({ sale_number: `200002222222222${index}`, sale_date_text: "3 de marzo de 2026 10:00 hs.", units: 1, sku: null, listing_id: "MLA3106141198", variant: `Color : ${color}` }),
    )
    assert.equal((await payloadFor(db, reportRows(lines).rows)).unlinked, 3, "la publicación sola no alcanza")
    await db.query(`insert into public.product_channel_mappings (channel, mapping_type, match_key, listing_id, variant_label, product_id, variant_id) values
      ('mercadolibre', 'listing_variant', 'MLA3106141198|color:rosa', 'MLA3106141198', 'Color : Rosa', 20, 202),
      ('mercadolibre', 'listing_variant', 'MLA3106141198|color:verde', 'MLA3106141198', 'Color : Verde', 20, 203)`)
    const { payload, unlinked } = await payloadFor(db, reportRows(lines).rows)
    assert.equal(unlinked, 1, "Negro no tiene vínculo: queda sin vincular")
    assert.deepEqual(payload.map((row) => (row.raw_data.beyonix_cost_mapping as { variant_id?: number } | undefined)?.variant_id ?? null), [null, 202, 203])
  } finally {
    await db.close()
  }
})
