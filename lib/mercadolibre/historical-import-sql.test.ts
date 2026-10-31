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
  "supabase/migrations/20261031160000_mercadolibre_import_stock_effect_decoupling.sql",
]

/** stopBefore: aplica las migraciones hasta esa (excluida) y no carga el catálogo. */
async function setup(stopBefore?: string) {
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
    -- Igual que producción: mercadolibre_sales_product_id_fkey ON DELETE SET NULL.
    alter table public.mercadolibre_sales add constraint mercadolibre_sales_product_id_fkey
      foreign key (product_id) references public.productos(id) on delete set null;
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
  for (const file of SETUP_MIGRATIONS) {
    if (stopBefore && file.endsWith(stopBefore)) return db
    await db.exec(read(file))
  }
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
  const existingIdentities = new Set<string>()
  const pendingManualLink = new Set<string>()
  for (const sale of await sales(db)) {
    const { operation_id, order_id, sale_date, product_name, sku, raw_data } = sale
    const identity = getMercadoLibreSaleIdentity({ operation_id, order_id, sale_date, product_name, sku, raw_data })
    existingIdentities.add(identity)
    if (sale.stock_effect === "consume" && sale.product_id == null) pendingManualLink.add(identity)
    const preserved = getPreservedCostMapping({ ...sale, unit_cost: 0 })
    if (preserved) preservedByIdentity.set(identity, preserved)
  }
  const context = buildMercadoLibreMatchingContext({ catalogTargetsBySku: buildUniqueCatalogTargetsBySku(catalog), catalog, mappings })
  return buildMercadoLibreImportPayload(
    rows,
    { context, preservedByIdentity, existingIdentities, pendingManualLink },
    { actorId: ACTOR, mappedAt: "2026-10-31T18:00:00.000Z" },
  )
}

/** Sin stockEffect: el lote toma el valor derivado del modo (compatibilidad con el código anterior). */
async function newBatch(db: PGlite, mode: "historical" | "current", stockEffect?: "consume" | "none") {
  return (await db.query<{ id: string }>(
    "insert into public.mercadolibre_import_batches (imported_by, source_file_name, import_mode, stock_effect) values ($1, 'ventas.xlsx', $2, $3) returning id",
    [ACTOR, mode, stockEffect ?? null],
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

/* ------------------------------------------------------------------ */
/* Tipo de importación ≠ impacto en stock (20261031160000)             */
/* ------------------------------------------------------------------ */

function line(sale_number: string, overrides: FixtureRow = {}) {
  return saleRow({ sale_number, sale_date_text: "13 de mayo de 2026 10:00 hs.", units: 2, sku: "AP01", listing_id: "MLA3268194664", variant: "Color : Negro", ...overrides })
}

async function importLines(db: PGlite, batch: string, lines: FixtureRow[]) {
  return importRows(db, batch, (await payloadFor(db, reportRows(lines).rows)).payload)
}

/**
 * Venta consume sin producto creada ANTES de la regla de vínculo (legado):
 * hoy la base no la deja crear, así que se simula desactivando esa regla.
 */
async function insertLegacyConsumeUnlinked(db: PGlite, operation: string, sku: string, listing = "MLA3268194664") {
  const raw = JSON.stringify({ report_format: "mercadolibre_ventas_ar", parsed: { status: "Entregado", units: 2, listing_id: listing, variant: "Color : Negro" } })
  await db.exec("alter table public.mercadolibre_sales disable trigger ab_validate_mercadolibre_consume_link")
  try {
    await db.query(
      `insert into public.mercadolibre_sales (source_key, operation_id, order_id, product_name, sku, quantity, sale_date, raw_data, stock_effect)
       values (public.mercadolibre_sale_source_key($1, $1, 'Legado', $2, '2026-05-13T10:00:00-03:00', $3::jsonb), $1, $1, 'Legado', $2, 2, '2026-05-13T10:00:00-03:00', $3::jsonb, 'consume')`,
      [operation, sku, raw],
    )
  } finally {
    await db.exec("alter table public.mercadolibre_sales enable trigger ab_validate_mercadolibre_consume_link")
  }
}

async function saleEffect(db: PGlite, operation: string) {
  return (await db.query<{ stock_effect: string }>("select stock_effect from public.mercadolibre_sales where operation_id = $1", [operation])).rows[0]?.stock_effect
}

test("combinaciones: historical+consume y current+consume descuentan, historical+none no, current+none se rechaza", async () => {
  const db = await setup()
  try {
    const before = await stockSnapshot(db)

    await importLines(db, await newBatch(db, "historical", "consume"), [line("2000050000000001")])
    assert.deepEqual(await stockSnapshot(db), { ...before, p10: 18 }, "historical + consume descuenta 2")
    assert.equal(await saleEffect(db, "2000050000000001"), "consume")

    await importLines(db, await newBatch(db, "historical", "none"), [line("2000050000000002")])
    assert.deepEqual(await stockSnapshot(db), { ...before, p10: 18 }, "historical + none no descuenta")
    assert.equal(await saleEffect(db, "2000050000000002"), "none")

    await importLines(db, await newBatch(db, "current", "consume"), [line("2000050000000003", { units: 1 })])
    assert.deepEqual(await stockSnapshot(db), { ...before, p10: 17 }, "current + consume mantiene el comportamiento")

    await assert.rejects(newBatch(db, "current", "none"), /mercadolibre_import_batches_mode_effect_check/)
    await assert.rejects(newBatch(db, "historical", "nada" as "none"), /mercadolibre_import_batches_stock_effect_check/)

    // Lote sin stock_effect explícito (código anterior): derivado del modo.
    const legacyHistorical = await newBatch(db, "historical")
    const legacyCurrent = await newBatch(db, "current")
    const derived = await db.query<{ id: string; stock_effect: string }>("select id, stock_effect from public.mercadolibre_import_batches where id in ($1, $2)", [legacyHistorical, legacyCurrent])
    assert.deepEqual(Object.fromEntries(derived.rows.map((row) => [row.id, row.stock_effect])), { [legacyHistorical]: "none", [legacyCurrent]: "consume" })

    // Inmutables: modo y stock del lote, stock de la venta.
    await assert.rejects(db.query("update public.mercadolibre_import_batches set stock_effect = 'none' where id = $1", [legacyCurrent]), /ML_IMPORT_MODE_IMMUTABLE/)
    await assert.rejects(db.query("update public.mercadolibre_import_batches set stock_effect = 'consume' where id = $1", [legacyHistorical]), /ML_IMPORT_MODE_IMMUTABLE/)
    await assert.rejects(db.query("update public.mercadolibre_sales set stock_effect = 'none' where operation_id = '2000050000000001'"), /ML_SALE_STOCK_EFFECT_IMMUTABLE/)
  } finally {
    await db.close()
  }
})

test("reimportar en otro impacto no cambia la venta ni duplica el descuento", async () => {
  const db = await setup()
  try {
    const before = await stockSnapshot(db)
    const consumeFirst = line("2000060000000001")
    const noneFirst = line("2000060000000002", { units: 1 })

    await importLines(db, await newBatch(db, "historical", "consume"), [consumeFirst])
    await importLines(db, await newBatch(db, "historical", "none"), [noneFirst])
    assert.equal((await stockSnapshot(db)).p10, 18)

    // Segunda vuelta con el impacto contrario: cada venta conserva el suyo.
    assert.equal((await importLines(db, await newBatch(db, "historical", "none"), [consumeFirst])).unchanged, 1)
    assert.equal((await importLines(db, await newBatch(db, "historical", "consume"), [noneFirst])).unchanged, 1)
    assert.equal(await saleEffect(db, "2000060000000001"), "consume")
    assert.equal(await saleEffect(db, "2000060000000002"), "none")
    assert.deepEqual(await stockSnapshot(db), { ...before, p10: 18 }, "una venta = una sola salida")

    // Un cambio real (reembolso) actualiza la línea sin agregar otra salida.
    await importLines(db, await newBatch(db, "historical", "consume"), [{ ...consumeFirst, total: 1000 }])
    assert.deepEqual(await stockSnapshot(db), { ...before, p10: 18 })
    const count = await db.query<{ count: number }>("select count(*)::int as count from public.mercadolibre_sales")
    assert.equal(count.rows[0].count, 2)
  } finally {
    await db.close()
  }
})

test("stock materializado: cantidad, estado, producto, variante y devolución física refrescan", async () => {
  const db = await setup()
  try {
    const before = await stockSnapshot(db)
    const batch = await newBatch(db, "current", "consume")
    const ap01 = line("2000070000000001")
    const mtn01 = line("2000070000000002", { sku: "MTN01", listing_id: "MLA3106141198" })
    await importLines(db, batch, [ap01, mtn01])
    assert.deepEqual(await stockSnapshot(db), { ...before, p10: 18, p20: 10, v201: 3 })

    // 8. Cantidad 2 → 3, mismo producto (reimportación real).
    assert.equal((await importLines(db, batch, [{ ...ap01, units: 3, product_revenue: 30000, total: 23175 }])).updated, 1)
    assert.equal((await stockSnapshot(db)).p10, 17)

    // 9. Normal → cancelada → normal.
    await db.query("update public.mercadolibre_sales set raw_data = jsonb_set(raw_data, '{parsed,status}', '\"Cancelada por el comprador\"') where operation_id = '2000070000000001'")
    assert.equal((await stockSnapshot(db)).p10, 20, "la salida cancelada desaparece")
    await db.query("update public.mercadolibre_sales set raw_data = jsonb_set(raw_data, '{parsed,status}', '\"Entregado\"') where operation_id = '2000070000000001'")
    assert.equal((await stockSnapshot(db)).p10, 17)

    // 10. Producto A → B: se refrescan los dos.
    await db.query(`update public.mercadolibre_sales set product_id = 40,
      raw_data = jsonb_set(raw_data, '{beyonix_cost_mapping}', '{"product_id":40,"variant_id":401}')
      where operation_id = '2000070000000001'`)
    assert.deepEqual(await stockSnapshot(db), { ...before, p10: 20, p40: 5, v401: 5, p20: 10, v201: 3 })

    // 11. Variante A → B del mismo producto: se refrescan las dos.
    await db.query("update public.mercadolibre_sales set raw_data = jsonb_set(raw_data, '{beyonix_cost_mapping,variant_id}', '202') where operation_id = '2000070000000002'")
    assert.deepEqual(await stockSnapshot(db), { ...before, p10: 20, p40: 5, v401: 5, p20: 10, v201: 5, v202: 2 })

    // 12. return_units null → 1 en el reporte: según las reglas vigentes sólo la
    //     revisión física vuelve stock (no el autoreporte de ML).
    const moved = { ...mtn01, status: "Devolución finalizada", return_units: 1, cancellations_refunds: -10000, total: -4550 }
    assert.equal((await importLines(db, batch, [moved])).updated, 1)
    assert.equal((await stockSnapshot(db)).v202, 2)
    const saleId = (await db.query<{ id: string }>("select id from public.mercadolibre_sales where operation_id = '2000070000000002'")).rows[0].id
    // Como review_mercadolibre_return: revisión aprobada con fecha efectiva.
    await db.query("insert into public.inventory_return_movements (mercadolibre_sale_id, product_id, variant_id, sellable_quantity, received_quantity, occurred_at, approved_at) values ($1, 20, 202, 1, 1, now(), now())", [saleId])
    assert.deepEqual(await stockSnapshot(db), { ...before, p10: 20, p40: 5, v401: 5, p20: 11, v201: 5, v202: 3 })

    // Recalcular todo reconstruye el mismo estado (no hay movimientos acumulativos).
    const snapshot = await stockSnapshot(db)
    await db.query("select public.refresh_inventory_stock(id) from public.productos")
    assert.deepEqual(await stockSnapshot(db), snapshot)
  } finally {
    await db.close()
  }
})

test("sin vínculo: consume se bloquea; none se permite y vincular después no mueve stock", async () => {
  const db = await setup()
  try {
    const before = await stockSnapshot(db)
    const unlinked = line("2000080000000001", { sku: "SKU-DESCONOCIDO", listing_id: "MLA8000000001" })

    // 13. consume + sin vínculo: el bloque entero se rechaza.
    const consumeBatch = await newBatch(db, "historical", "consume")
    await assert.rejects(importLines(db, consumeBatch, [line("2000080000000002"), unlinked]), /ML_IMPORT_UNLINKED_CONSUME/)
    const none = await db.query<{ count: number }>("select count(*)::int as count from public.mercadolibre_sales")
    assert.equal(none.rows[0].count, 0, "atómico: tampoco entra la línea vinculada")
    assert.deepEqual(await stockSnapshot(db), before)

    // 14. none + sin vínculo: permitido, conserva SKU original y finanzas.
    await importLines(db, await newBatch(db, "historical", "none"), [unlinked])
    const [stored] = await sales(db)
    assert.deepEqual([stored.sku, stored.product_id, stored.stock_effect, Number(stored.gross_amount)], ["SKU-DESCONOCIDO", null, "none", 20000])

    // 15. Vincularla después no mueve stock.
    await db.query(`update public.mercadolibre_sales set product_id = 10,
      raw_data = raw_data || '{"beyonix_cost_mapping":{"product_id":10,"variant_id":null}}' where id = $1`, [stored.id])
    assert.deepEqual(await stockSnapshot(db), before)

    // Legado: una venta consume sin vínculo (anterior al bloqueo) sólo se
    // vincula a mano, y eso genera UNA salida aunque se repita.
    await insertLegacyConsumeUnlinked(db, "2000080000000009", "AP01")
    assert.deepEqual(await stockSnapshot(db), before)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await db.query(`update public.mercadolibre_sales set product_id = 10,
        raw_data = raw_data || '{"beyonix_cost_mapping":{"product_id":10,"variant_id":null}}' where operation_id = '2000080000000009'`)
    }
    assert.deepEqual(await stockSnapshot(db), { ...before, p10: 18 })
  } finally {
    await db.close()
  }
})

test("XLSX auditado como historical + consume con los 4 SKU vinculados: descuenta 13 y la devolución no reingresa", async () => {
  const db = await setup()
  try {
    const before = await stockSnapshot(db)
    // Sólo en este test: vínculos de ejemplo para los 4 SKU sin match.
    await db.query(`insert into public.product_channel_mappings (channel, mapping_type, match_key, external_sku, product_id, variant_id) values
      ('mercadolibre', 'sku_alias', 'AURIVINEXTMALIBUVER', 'AURIVINEXTMALIBUVER', 30, 301),
      ('mercadolibre', 'sku_alias', 'AURIVINEXTMALIBUNEG', 'AURIVINEXTMALIBUNEG', 30, 302),
      ('mercadolibre', 'sku_alias', 'MATEINOXROSA001', 'MATEINOXROSA001', 20, 202),
      ('mercadolibre', 'sku_alias', 'MATEINOXVERDE001', 'MATEINOXVERDE001', 20, 203)`)

    // Sin los vínculos completos la importación consume se bloquea; con ellos pasa.
    const { payload, unlinked } = await payloadFor(db, reportRows(AUDITED_LINES).rows)
    assert.equal(unlinked, 0)
    assert.deepEqual(await importRows(db, await newBatch(db, "historical", "consume"), payload), { received: 11, inserted: 11, updated: 0, unchanged: 0, duplicate_rows: 0 })

    const after = await stockSnapshot(db)
    assert.deepEqual(after, {
      ...before,
      p10: before.p10 - 7, // AP01: 2 + 1 + 2 (devolución) + 1 + 1
      p20: before.p20 - 4, v201: before.v201 - 2, v202: before.v202 - 1, v203: before.v203 - 1,
      p30: before.p30 - 2, v301: before.v301 - 1, v302: before.v302 - 1,
    })
    const productKeys = Object.keys(before).filter((key) => key.startsWith("p"))
    assert.equal(productKeys.reduce((sum, key) => sum + before[key] - after[key], 0), 13, "13 unidades en total")

    const returned = (await sales(db)).find((sale) => sale.operation_id === RETURN_SALE)!
    assert.equal(returned.stock_effect, "consume")
    assert.equal((returned.raw_data.parsed as Record<string, unknown>).return_units, null)
    assert.equal(getMercadoLibreCostableUnits(returned), 2)
    assert.equal(getMercadoLibreRefundAmount(returned), 41670)
    const returns = await db.query<{ count: number }>("select count(*)::int as count from public.inventory_return_movements")
    assert.equal(returns.rows[0].count, 0, "no se reingresa nada sin revisión física")
  } finally {
    await db.close()
  }
})

/* ------------------------------------------------------------------ */
/* P0: una venta consume siempre tiene un vínculo válido               */
/* ------------------------------------------------------------------ */

const insertSale = (db: PGlite, operation: string, effect: "consume" | "none", productId: number | null, variantId: number | null = null) =>
  db.query(
    `insert into public.mercadolibre_sales (operation_id, order_id, product_name, sku, quantity, sale_date, raw_data, product_id, stock_effect)
     values ($1, $1, 'Directa', 'X', 1, '2026-05-01', $2::jsonb, $3, $4)`,
    [operation, JSON.stringify({ parsed: { status: "Entregado" }, ...(productId ? { beyonix_cost_mapping: { product_id: productId, variant_id: variantId } } : {}) }), productId, effect],
  )

test("base: INSERT/UPDATE directos no pueden dejar una venta consume sin vínculo válido", async () => {
  const db = await setup()
  try {
    const before = await stockSnapshot(db)
    // 1–3. consume sin producto, sin la variante obligatoria o con variante ajena.
    await assert.rejects(insertSale(db, "9100000000000001", "consume", null), /ML_CONSUME_SALE_LINK_REQUIRED/)
    await assert.rejects(insertSale(db, "9100000000000002", "consume", 20, null), /ML_CONSUME_SALE_LINK_REQUIRED: el producto de la venta .* tiene variantes/)
    await assert.rejects(insertSale(db, "9100000000000003", "consume", 20, 301), /ML_CONSUME_SALE_LINK_REQUIRED: la variante/)
    await assert.rejects(insertSale(db, "9100000000000004", "consume", 10, 999), /ML_CONSUME_SALE_LINK_REQUIRED: la variante/)
    await assert.rejects(insertSale(db, "9100000000000005", "consume", 777), /ML_CONSUME_SALE_LINK_REQUIRED: el producto de la venta .* no existe/)
    assert.deepEqual(await stockSnapshot(db), before)

    // 4. consume válido: con y sin variante.
    await insertSale(db, "9100000000000006", "consume", 20, 202)
    await insertSale(db, "9100000000000007", "consume", 10)
    assert.deepEqual(await stockSnapshot(db), { ...before, p20: 11, v202: 3, p10: 19 })

    // 5. none sin vínculo: permitido, sin stock.
    await insertSale(db, "9100000000000008", "none", null)
    assert.deepEqual(await stockSnapshot(db), { ...before, p20: 11, v202: 3, p10: 19 })

    // 6. none → consume: inmutable. consume → sin producto o variante inválida: rechazado.
    await assert.rejects(db.query("update public.mercadolibre_sales set stock_effect = 'consume' where operation_id = '9100000000000008'"), /ML_SALE_STOCK_EFFECT_IMMUTABLE/)
    await assert.rejects(db.query("update public.mercadolibre_sales set product_id = null where operation_id = '9100000000000007'"), /ML_CONSUME_SALE_LINK_REQUIRED/)
    await assert.rejects(db.query("update public.mercadolibre_sales set raw_data = raw_data #- '{beyonix_cost_mapping,variant_id}' where operation_id = '9100000000000006'"), /ML_CONSUME_SALE_LINK_REQUIRED/)
    await assert.rejects(db.query("update public.mercadolibre_sales set raw_data = jsonb_set(raw_data, '{beyonix_cost_mapping,variant_id}', '301') where operation_id = '9100000000000006'"), /ML_CONSUME_SALE_LINK_REQUIRED/)
    await assert.rejects(db.query("update public.mercadolibre_sales set product_id = 30 where operation_id = '9100000000000006'"), /ML_CONSUME_SALE_LINK_REQUIRED/)
    assert.deepEqual(await stockSnapshot(db), { ...before, p20: 11, v202: 3, p10: 19 })
  } finally {
    await db.close()
  }
})

test("base: borrar el producto o la variante de una venta consume se bloquea", async () => {
  const db = await setup()
  try {
    await insertSale(db, "9200000000000001", "consume", 10)
    await insertSale(db, "9200000000000002", "consume", 30, 301)
    // Venta consume cancelada: no deja movimiento, pero igual protege su variante.
    await insertSale(db, "9200000000000003", "consume", 30, 302)
    await db.query("update public.mercadolibre_sales set raw_data = jsonb_set(raw_data, '{parsed,status}', '\"Cancelada\"') where operation_id = '9200000000000003'")
    // Una venta none sí puede perder su variante: no afecta stock.
    await insertSale(db, "9200000000000004", "none", 20, 203)

    await assert.rejects(db.query("delete from public.productos where id = 10"), /ML_CONSUME_SALE_LINK_REQUIRED/, "ON DELETE SET NULL no deja la venta sin producto")
    await assert.rejects(db.query("delete from public.producto_variantes where id = 301"), /ML_CONSUME_SALE_LINK_REQUIRED/)
    await assert.rejects(db.query("delete from public.producto_variantes where id = 302"), /ML_CONSUME_SALE_LINK_REQUIRED/)
    await db.query("delete from public.producto_variantes where id = 203")

    const linked = await db.query<{ operation_id: string; product_id: number }>(
      "select operation_id, product_id::int from public.mercadolibre_sales where stock_effect = 'consume' order by operation_id",
    )
    assert.deepEqual(linked.rows, [
      { operation_id: "9200000000000001", product_id: 10 },
      { operation_id: "9200000000000002", product_id: 30 },
      { operation_id: "9200000000000003", product_id: 30 },
    ])
  } finally {
    await db.close()
  }
})

test("legado consume sin vínculo: mapping nuevo + reimportación no lo vincula; sólo la acción manual, una vez", async () => {
  const db = await setup()
  try {
    const before = await stockSnapshot(db)
    await insertLegacyConsumeUnlinked(db, "9300000000000001", "VIEJO-AP")
    assert.deepEqual(await stockSnapshot(db), before)

    // Aparece un alias para su SKU y se reimporta el mismo archivo en un lote consume.
    await db.query("insert into public.product_channel_mappings (channel, mapping_type, match_key, external_sku, product_id) values ('mercadolibre', 'sku_alias', 'VIEJO-AP', 'VIEJO-AP', 10)")
    const reimport = [line("9300000000000001", { sku: "VIEJO-AP", sale_date_text: "13 de mayo de 2026 10:00 hs." })]
    const resolved = await payloadFor(db, reportRows(reimport).rows)
    assert.equal(resolved.unlinked, 1, "el servidor no lo vincula")
    assert.equal(resolved.newUnlinked, 0, "no es una venta nueva: no bloquea el lote")
    const batch = await newBatch(db, "historical", "consume")
    await importRows(db, batch, resolved.payload)

    // Aunque un payload (bug o código viejo) traiga producto, la RPC tampoco lo vincula.
    const forced = resolved.payload.map((row) => ({ ...row, product_id: 10, raw_data: { ...row.raw_data, beyonix_cost_mapping: { product_id: 10, variant_id: null } } }))
    await importRows(db, await newBatch(db, "historical", "consume"), forced)

    let [legacy] = (await sales(db)).filter((sale) => sale.operation_id === "9300000000000001")
    assert.equal(legacy.product_id, null)
    assert.equal(legacy.raw_data.beyonix_cost_mapping, undefined)
    assert.deepEqual(await stockSnapshot(db), before, "no empezó a descontar solo")

    // Acción explícita (lo que hace PATCH /api/admin/mercadolibre-sales): una salida.
    const link = () => db.query(
      `update public.mercadolibre_sales set product_id = 10,
         raw_data = raw_data || '{"beyonix_cost_mapping":{"product_id":10,"variant_id":null,"match_key":"sku:VIEJO-AP","mapped_by":"${ACTOR}"}}'
       where operation_id = '9300000000000001'`,
    )
    await link()
    assert.deepEqual(await stockSnapshot(db), { ...before, p10: 18 })
    await link()
    assert.deepEqual(await stockSnapshot(db), { ...before, p10: 18 }, "repetir no duplica la salida")
    // Una vez vinculada, reimportar conserva el vínculo y la única salida.
    await importRows(db, await newBatch(db, "historical", "consume"), (await payloadFor(db, reportRows(reimport).rows)).payload)
    ;[legacy] = (await sales(db)).filter((sale) => sale.operation_id === "9300000000000001")
    assert.equal(Number(legacy.product_id), 10)
    assert.deepEqual(await stockSnapshot(db), { ...before, p10: 18 })
    // Y ya no se puede volver a desvincular.
    await assert.rejects(db.query("update public.mercadolibre_sales set product_id = null where operation_id = '9300000000000001'"), /ML_CONSUME_SALE_LINK_REQUIRED/)
  } finally {
    await db.close()
  }
})

test("backfill del lote: historical existente → none, current existente → consume", async () => {
  const db = await setup("20261031160000_mercadolibre_import_stock_effect_decoupling.sql")
  try {
    await db.exec(`insert into auth.users values ('${ACTOR}') on conflict do nothing`)
    const ids = (await db.query<{ id: string; import_mode: string }>(
      "insert into public.mercadolibre_import_batches (imported_by, source_file_name, import_mode) values ($1, 'a.xlsx', 'historical'), ($1, 'b.xlsx', 'current') returning id, import_mode",
      [ACTOR],
    )).rows
    await db.exec(read("supabase/migrations/20261031160000_mercadolibre_import_stock_effect_decoupling.sql"))
    const after = await db.query<{ import_mode: string; stock_effect: string }>(
      "select import_mode, stock_effect from public.mercadolibre_import_batches where id = any($1::uuid[]) order by import_mode",
      [ids.map((row) => row.id)],
    )
    assert.deepEqual(after.rows, [
      { import_mode: "current", stock_effect: "consume" },
      { import_mode: "historical", stock_effect: "none" },
    ])
    const nullable = await db.query<{ is_nullable: string }>(
      "select is_nullable from information_schema.columns where table_name = 'mercadolibre_import_batches' and column_name = 'stock_effect'",
    )
    assert.equal(nullable.rows[0].is_nullable, "NO")
  } finally {
    await db.close()
  }
})
