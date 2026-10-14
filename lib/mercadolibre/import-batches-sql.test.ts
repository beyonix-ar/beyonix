import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

const migration = (name: string) =>
  readFileSync(new URL(`../../supabase/migrations/${name}`, import.meta.url), "utf8")

const ACTOR = "11111111-1111-4111-8111-111111111111"

async function setup() {
  const db = new PGlite()
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table auth.users (id uuid primary key, email text);
    create table public.profiles (id uuid primary key, email text);
    create table public.productos (id bigint primary key, stock integer not null default 0);
    create table public.producto_variantes (id bigint primary key, producto_id bigint, stock integer not null default 0);
    create table public.audit_logs (
      id bigserial primary key, table_name text not null, action text not null, record_id text,
      actor_user_id uuid, actor_email text, before_data jsonb, after_data jsonb,
      created_at timestamptz not null default now()
    );
    create table public.mercadolibre_sales (
      id uuid primary key default gen_random_uuid(),
      sale_date timestamptz, operation_id text, order_id text, product_name text not null,
      sku text, quantity integer not null default 1 check (quantity > 0),
      gross_amount numeric(12,2) not null default 0, fee_amount numeric(12,2),
      shipping_amount numeric(12,2), net_amount numeric(12,2), source_file_name text,
      imported_by uuid, imported_at timestamptz not null default now(),
      raw_data jsonb not null default '{}'::jsonb, product_id bigint,
      unit_cost numeric(12,2) not null default 0
    );
    create table public.inventory_return_movements (
      id uuid primary key default gen_random_uuid(),
      mercadolibre_sale_id uuid references public.mercadolibre_sales(id) on delete cascade,
      received_quantity integer not null default 0
    );
    insert into auth.users values ('${ACTOR}', 'admin@beyonix.test');
  `)
  return db
}

function row(operation: string, overrides: Record<string, unknown> = {}, parsed: Record<string, unknown> = {}) {
  return {
    sale_date: "2026-10-01T23:50:00-03:00",
    operation_id: operation,
    order_id: operation,
    product_name: "Auriculares Ñandú Pro",
    sku: "AUR-01",
    quantity: 2,
    gross_amount: 20000,
    fee_amount: 2750,
    shipping_amount: 1800,
    net_amount: 15450,
    raw_data: {
      report_format: "mercadolibre_ventas_ar",
      parsed: { status: "Entregada", units: 2, listing_id: "MLA123", variant: "Color : Negro", return_units: 0, cancellations_refunds: 0, ...parsed },
      grouped: {},
      source: { sheet: "Ventas AR", row_number: 7, cells: [] },
    },
    ...overrides,
  }
}

test("SQL real: identidad v2, lotes idempotentes, solapamiento, previsualización, reversión y permisos", async () => {
  const db = await setup()
  try {
    // Estado previo: dos ventas cargadas con la identidad v1 que difieren sólo en espacios.
    await db.exec(migration("20260801090000_idempotent_mercadolibre_import.sql"))
    await db.query(
      `insert into public.mercadolibre_sales (source_key, operation_id, order_id, product_name, quantity, raw_data, imported_at)
       values
        (public.mercadolibre_sale_source_key('900', '900', 'Mate', null, null, '{"parsed":{"listing_id":"MLA9","variant":"Negro  Mate"}}'), '900', '900', 'Mate', 1, '{"parsed":{"listing_id":"MLA9","variant":"Negro  Mate"}}', now() - interval '2 days'),
        (public.mercadolibre_sale_source_key('900', '900', 'Mate', null, null, '{"parsed":{"listing_id":"MLA-9","variant":"Negro Mate"}}'), '900', '900', 'Mate', 1, '{"parsed":{"listing_id":"MLA-9","variant":"Negro Mate"}}', now() - interval '1 day')`,
    )

    await db.exec(migration("20261015100000_mercadolibre_import_batches.sql"))

    const legacy = await db.query<{ source_key: string }>("select source_key from public.mercadolibre_sales where operation_id = '900' order by imported_at")
    assert.match(legacy.rows[0].source_key, /^ml:v2:[0-9a-f]{32}$/)
    assert.match(legacy.rows[1].source_key, /^ml:v2:[0-9a-f]{32}:legacy:/, "la colisión no borra la venta histórica")

    const newBatch = async (file = "ventas.xlsx") =>
      (await db.query<{ id: string }>(
        "insert into public.mercadolibre_import_batches (imported_by, source_file_name, rows_read) values ($1, $2, 3) returning id",
        [ACTOR, file],
      )).rows[0].id
    const importRows = async (batch: string, rows: unknown[]) =>
      (await db.query<{ result: Record<string, number> }>(
        "select public.import_mercadolibre_sales_batch($1, $2::jsonb, $3) as result",
        [batch, JSON.stringify(rows), ACTOR],
      )).rows[0].result
    const preview = async (rows: unknown[]) =>
      (await db.query<{ result: Array<{ status: string }> }>(
        "select public.preview_mercadolibre_import($1::jsonb) as result",
        [JSON.stringify(rows)],
      )).rows[0].result.map((item) => item.status)

    const fileA = [row("1001"), row("1002"), row("1003")]
    assert.deepEqual(await preview(fileA), ["new", "new", "new"])

    // 1. Primera importación.
    const batchA = await newBatch("octubre.xlsx")
    assert.deepEqual(await importRows(batchA, fileA), { received: 3, inserted: 3, updated: 0, unchanged: 0, duplicate_rows: 0 })
    const stored = await db.query<{ count: number; batch: string; last: string; source: string }>(
      "select count(*)::int as count, min(import_batch_id::text) as batch, min(last_import_batch_id::text) as last, min(source_file_name) as source from public.mercadolibre_sales where operation_id like '100%'",
    )
    assert.deepEqual(stored.rows[0], { count: 3, batch: batchA, last: batchA, source: "octubre.xlsx" })

    // 2. Mismo archivo otra vez: nada cambia.
    assert.deepEqual(await preview(fileA), ["unchanged", "unchanged", "unchanged"])
    const batchB = await newBatch("octubre.xlsx")
    assert.deepEqual(await importRows(batchB, fileA), { received: 3, inserted: 0, updated: 0, unchanged: 3, duplicate_rows: 0 })

    // Compatibilidad de despliegue: la RPC anterior (código viejo) ve la misma identidad.
    const legacyCall = (await db.query<{ result: Record<string, number> }>(
      "select public.import_mercadolibre_sales_idempotent($1::jsonb, $2, 'octubre.xlsx') as result",
      [JSON.stringify(fileA), ACTOR],
    )).rows[0].result
    assert.equal(legacyCall.inserted, 0, "el código anterior tampoco duplica después de la migración")

    // 3. Mismas ventas con formato distinto (espacios, guiones, mayúsculas): no duplica.
    const reformatted = row("1001", { product_name: "Auriculares  Ñandú Pro" }, { listing_id: "mla-123", variant: "Color :  Negro" })
    assert.deepEqual(await preview([reformatted]), ["changed"])

    // 4. Archivo solapado: 1003 ahora es devolución, 1004 es nueva, 1002 igual.
    const devolucion = row("1003", { net_amount: -4550 }, { status: "Devolución finalizada", return_units: 2, cancellations_refunds: -20000 })
    const fileC = [row("1002"), devolucion, row("1004")]
    assert.deepEqual(await preview(fileC), ["unchanged", "changed", "new"])
    const batchC = await newBatch("octubre-noviembre.xlsx")
    assert.deepEqual(await importRows(batchC, fileC), { received: 3, inserted: 1, updated: 1, unchanged: 1, duplicate_rows: 0 })
    const after = await db.query<{ operation_id: string; batch: string; last: string; net: string }>(
      "select operation_id, import_batch_id::text as batch, last_import_batch_id::text as last, net_amount::text as net from public.mercadolibre_sales where operation_id like '100%' order by operation_id",
    )
    assert.deepEqual(after.rows.map((item) => [item.operation_id, item.batch === batchA ? "A" : "C", item.last === batchA ? "A" : item.last === batchC ? "C" : "?"]), [
      ["1001", "A", "A"], ["1002", "A", "A"], ["1003", "A", "C"], ["1004", "C", "C"],
    ])
    assert.equal(after.rows[2].net, "-4550.00")

    // 5. Un reporte viejo no retrocede una devolución ya registrada.
    assert.deepEqual(await preview([row("1003")]), ["stale"])
    const batchD = await newBatch("septiembre-viejo.xlsx")
    assert.equal((await importRows(batchD, [row("1003")])).unchanged, 1)

    // 6. Contadores del lote.
    const counters = await db.query("select inserted, updated, unchanged from public.mercadolibre_import_batches where id = $1", [batchC])
    assert.deepEqual(counters.rows[0], { inserted: 1, updated: 1, unchanged: 1 })

    // 7. Validaciones server-side.
    await assert.rejects(importRows(batchD, [row("ABC")]), /ML_IMPORT_INVALID_ROW: la fila 7 no tiene un número de venta válido/)
    await assert.rejects(importRows(batchD, [row("1005", { quantity: 0 })]), /unidades inválidas/)
    await assert.rejects(importRows(batchD, [row("1005", { sale_date: "mañana" })]), /fechas, cantidades o importes inválidos/)
    await assert.rejects(importRows(batchD, [row("1005"), row("1005", { quantity: 5 })]), /ML_IMPORT_CONFLICT/)
    await db.query("update public.mercadolibre_import_batches set status = 'completed' where id = $1", [batchD])
    await assert.rejects(importRows(batchD, [row("1006")]), /ML_IMPORT_BATCH_CLOSED/)

    // 8. Reversión del lote A: 1001 y 1002 se borran; 1003 (modificada por C) se conserva;
    //    una venta con revisión física de devolución también se conserva.
    await db.query(
      "insert into public.inventory_return_movements (mercadolibre_sale_id, received_quantity) select id, 1 from public.mercadolibre_sales where operation_id = '1002'",
    )
    await db.query("update public.mercadolibre_import_batches set status = 'completed' where id = $1", [batchA])
    await assert.rejects(
      db.query("select public.revert_mercadolibre_import_batch($1, 5, $2)", [batchA, ACTOR]),
      /ML_IMPORT_REVERT_CHANGED/,
    )
    const reverted = (await db.query<{ result: Record<string, unknown> }>(
      "select public.revert_mercadolibre_import_batch($1, 1, $2) as result",
      [batchA, ACTOR],
    )).rows[0].result
    assert.deepEqual(reverted, { deleted: 1, kept_modified_later: 1, kept_with_return_review: 1, updated_not_reversible: 0, status: "partially_reverted" })
    const remaining = await db.query<{ operation_id: string }>("select operation_id from public.mercadolibre_sales where operation_id like '100%' order by operation_id")
    assert.deepEqual(remaining.rows.map((item) => item.operation_id), ["1002", "1003", "1004"])
    const audit = await db.query<{ record_id: string; deleted: number }>(
      "select record_id, (before_data ->> 'deleted_count')::int as deleted from public.audit_logs where record_id = 'import-batch:' || $1",
      [batchA],
    )
    assert.deepEqual(audit.rows, [{ record_id: `import-batch:${batchA}`, deleted: 1 }])
    await assert.rejects(
      db.query("select public.revert_mercadolibre_import_batch($1, 0, $2)", [batchA, ACTOR]),
      /ML_IMPORT_BATCH_NOT_REVERSIBLE/,
    )

    // 9. Volumen: 1.000 ventas en bloques de 500 y reimportación completa sin cambios.
    const many = Array.from({ length: 1000 }, (_, index) => row(String(5000 + index)))
    const batchE = await newBatch("anual.xlsx")
    const started = performance.now()
    await importRows(batchE, many.slice(0, 500))
    await importRows(batchE, many.slice(500))
    const firstPass = performance.now() - started
    const batchF = await newBatch("anual.xlsx")
    const again = [await importRows(batchF, many.slice(0, 500)), await importRows(batchF, many.slice(500))]
    console.log(`  1.000 ventas: ${Math.round(firstPass)} ms en la primera importación`)
    assert.equal(again.reduce((total, part) => total + part.unchanged, 0), 1000)
    assert.equal((await db.query<{ count: number }>("select count(*)::int as count from public.mercadolibre_sales where operation_id::bigint >= 5000")).rows[0].count, 1000)
    await assert.rejects(importRows(batchF, Array.from({ length: 501 }, (_, index) => row(String(9000 + index)))), /ML_IMPORT_TOO_LARGE/)

    // 10. Permisos: sólo service_role ejecuta las funciones y lee el historial.
    const privileges = await db.query(`
      select
        has_function_privilege('authenticated', 'public.import_mercadolibre_sales_batch(uuid, jsonb, uuid)', 'EXECUTE') as import_auth,
        has_function_privilege('authenticated', 'public.revert_mercadolibre_import_batch(uuid, integer, uuid)', 'EXECUTE') as revert_auth,
        has_function_privilege('authenticated', 'public.preview_mercadolibre_import(jsonb)', 'EXECUTE') as preview_auth,
        has_function_privilege('service_role', 'public.import_mercadolibre_sales_batch(uuid, jsonb, uuid)', 'EXECUTE') as import_service,
        has_table_privilege('authenticated', 'public.mercadolibre_import_batches', 'SELECT') as batches_auth
    `)
    assert.deepEqual(privileges.rows[0], { import_auth: false, revert_auth: false, preview_auth: false, import_service: true, batches_auth: false })
  } finally {
    await db.close()
  }
})
