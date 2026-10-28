import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

// Ventas externas contra las migraciones reales: tandas Históricas/Nuevas,
// reservas web, duplicados, edición con versión, anulación vs devolución y
// deshacer tanda, todo sobre el libro de inventario derivado
// (inventory_movements + refresh_inventory_stock).

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8").replace(/\r\n/g, "\n")
const MIGRATION = "supabase/migrations/20261027210000_external_sales_imports_and_lifecycle.sql"
const ADMIN = "10000000-0000-4000-8000-000000000001"
const OPERATOR = "10000000-0000-4000-8000-000000000002"

const FIXTURE = read("lib/business/fixtures/external-sales-schema.sql")

const SETUP_MIGRATIONS = [
  "supabase/migrations/20260801100000_inventory_sale_write_guards.sql",
  "supabase/migrations/20260918100000_refresh_inventory_stock_fail_closed.sql",
  "supabase/migrations/20260918150000_purchase_inventory_refresh_reproducibility.sql",
  "supabase/migrations/20260921100000_external_sale_reversal.sql",
  "supabase/migrations/20260923110000_external_sale_creation_and_write_guards.sql",
  MIGRATION,
]

async function setup() {
  const db = new PGlite()
  await db.exec(FIXTURE)
  for (const file of SETUP_MIGRATIONS) await db.exec(read(file))
  await db.exec(`
    insert into auth.users values ('${ADMIN}'), ('${OPERATOR}');
    insert into public.profiles values ('${ADMIN}', 'admin', 'admin@beyonix.test'), ('${OPERATOR}', 'operador', 'op@beyonix.test');
    insert into public.productos (id, nombre, sku, activo) values
      (1, 'Auricular Ñandú', 'AUR-1', true), (2, 'Funda Ñandú', 'FUN', true), (3, 'Parlante viejo', 'ARCH-1', false);
    insert into public.producto_variantes (id, producto_id, nombre, sku) values (21, 2, 'Negra', 'FUN-NEG'), (22, 2, 'Azul', 'FUN-AZU');
    insert into public.catalog_sku_registry values ('AUR-1', 1, null, null), ('FUN', 2, null, null),
      ('FUN-NEG', null, 21, null), ('FUN-AZU', null, 22, null), ('ARCH-1', 3, null, null);
    insert into public.product_cost_entries (product_id, variant_id, sku, purchase_date, received_quantity) values
      (1, null, 'AUR-1', '2026-01-01', 10), (2, 21, 'FUN-NEG', '2026-01-01', 5), (2, 22, 'FUN-AZU', '2026-01-01', 3),
      (3, null, 'ARCH-1', '2026-01-01', 2), (null, null, 'VIEJO-1', '2025-01-01', 0);
    select public.refresh_inventory_stock(1); select public.refresh_inventory_stock(2); select public.refresh_inventory_stock(3);
  `)
  return db
}

type Row = Record<string, unknown>
const sourceValues = (sku: string) => ({
  Fecha: "15/03/2026", Cliente: "Lucía Pérez", Canal: "WhatsApp", SKU: sku, Producto: "Auricular Ñandú",
  "Cant.": "1", Costo: "$ 11.000", "Envío": "$ 0", Total: "$ 15.000", "Medio de pago": "Transferencia",
  Estado: "Entregada", "Precio Final": "$ 15.000", Ganancia: "$ 4.000", "Observación": "Entrega en mano",
})
function sale(row: number, overrides: Row = {}): Row {
  const sku = String(overrides.sku ?? "AUR-1")
  return {
    source_row_number: row, sale_date: "2026-03-15", customer_name: `Cliente ${row}`, channel: "whatsapp",
    channel_label: "WhatsApp", sku, product_name: "Auricular Ñandú", quantity: 1, shipping_amount: 0,
    payment_method: "Transferencia", payment_method_code: "transfer", status: "delivered",
    gross_amount: 15000, declared_profit: 4000, notes: "Entrega en mano", source_values: sourceValues(sku),
    ...overrides,
  }
}

let keyCounter = 0
const key = (prefix = "key") => `${prefix}-${String(++keyCounter).padStart(6, "0")}`

async function importBatch(db: PGlite, rows: Row[], mode: "none" | "consume", idempotencyKey = key("import"), actor = ADMIN) {
  const result = await db.query<{ r: { batch_id: string; imported: number; replayed: boolean } }>(
    "select public.import_external_sales_batch($1::jsonb, $2::jsonb, $3, $4) as r",
    [JSON.stringify({ source: "paste", stock_mode: mode, rows_read: rows.length }), JSON.stringify(rows), actor, idempotencyKey],
  )
  return result.rows[0].r
}
async function stock(db: PGlite) {
  const products = (await db.query<{ id: number; stock: number }>("select id, stock from productos order by id")).rows
  const variants = (await db.query<{ id: number; stock: number }>("select id, stock from producto_variantes order by id")).rows
  return {
    aur: Number(products[0].stock), funda: Number(products[1].stock), arch: Number(products[2].stock),
    negra: Number(variants[0].stock), azul: Number(variants[1].stock),
  }
}
const one = async <T,>(db: PGlite, sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0]
const saleBy = (db: PGlite, where: string, params: unknown[] = []) =>
  one<{ id: string; version: number; status: string; quantity: number; stock_effect: string }>(db, `select * from external_sales where ${where}`, params)
const update = (db: PGlite, id: string, version: number, patch: Row, actor = ADMIN) =>
  one<{ r: { version: number; quantity: number; product_id: number | null; variant_id: number | null; sku: string } }>(
    db, "select to_jsonb(public.update_external_sale($1, $2, $3::jsonb, $4, 'Corrección de carga')) as r",
    [id, version, JSON.stringify(patch), actor],
  ).then((row) => row.r)
const cancel = (db: PGlite, id: string, kind: string, condition: string | null, idempotencyKey = key("cancel"), version: number | null = null) =>
  one<{ r: { status: string; reversal_kind: string; return_condition: string | null; reversed_at: string } }>(
    db, "select to_jsonb(public.cancel_external_sale($1, $2, $3, 'Motivo suficientemente claro', $4, $5, $6)) as r",
    [id, kind, condition, ADMIN, idempotencyKey, version],
  ).then((row) => row.r)

const BASE = { aur: 10, funda: 8, arch: 2, negra: 5, azul: 3 }

test("44. importación histórica: conserva fecha, precio, ganancia, origen y fila original sin mover stock", async () => {
  const db = await setup()
  try {
    const rows = [
      sale(2),
      sale(3, { sku: "FUN-NEG", product_name: "", quantity: 2, gross_amount: 9000, declared_profit: -500, sale_date: "2025-12-24" }),
      sale(4, { sku: "ARCH-1", product_name: "Parlante viejo" }),
      sale(5, { sku: "VIEJO-1", product_name: "Cargador discontinuado", gross_amount: 3000, declared_profit: null }),
    ]
    const result = await importBatch(db, rows, "none")
    assert.equal(result.imported, 4)
    assert.deepEqual(await stock(db), BASE, "una tanda histórica no mueve el stock actual")

    const stored = (await db.query<Row>(
      "select source_row_number, sale_date::text, sku, product_id::int, variant_id::int, product_name, quantity, gross_amount::text, declared_profit::text, stock_effect, origin, status, channel, payment_method_code, source_values from external_sales order by source_row_number",
    )).rows
    assert.deepEqual(stored.map((row) => [row.source_row_number, row.sale_date, row.product_id, row.variant_id, row.gross_amount, row.declared_profit, row.stock_effect, row.origin]), [
      [2, "2026-03-15", 1, null, "15000.00", "4000.00", "none", "paste"],
      [3, "2025-12-24", 2, 21, "9000.00", "-500.00", "none", "paste"],
      [4, "2026-03-15", 3, null, "15000.00", "4000.00", "none", "paste"],
      [5, "2026-03-15", null, null, "3000.00", null, "none", "paste"],
    ])
    assert.equal(stored[1].product_name, "Funda Ñandú · Negra", "sin nombre en el Excel usa el del catálogo")
    assert.equal(stored[3].product_name, "Cargador discontinuado", "SKU histórico conserva el nombre del Excel")
    assert.deepEqual(stored[0].source_values, sourceValues("AUR-1"), "conserva las 14 columnas originales, incluidas Costo y Total")
    assert.equal(stored[0].status, "delivered")
    assert.equal(stored[0].channel, "whatsapp")
    assert.equal(stored[0].payment_method_code, "transfer")

    const today = await one<{ n: number }>(db, "select count(*)::int n from external_sales where sale_date = (now() at time zone 'America/Argentina/Buenos_Aires')::date")
    assert.equal(today.n, 0, "importar hoy no crea ventas de hoy")
    const batch = await one<Row>(db, "select source, stock_mode, rows_read, rows_valid, rows_imported, status, created_by::text from external_sale_import_batches")
    assert.deepEqual(batch, { source: "paste", stock_mode: "none", rows_read: 4, rows_valid: 4, rows_imported: 4, status: "completed", created_by: ADMIN })
    const audit = await one<{ n: number }>(db, "select count(*)::int n from audit_logs where after_data ->> 'scope' = 'external_sale_import' and actor_user_id = $1", [ADMIN])
    assert.equal(audit.n, 1)
  } finally {
    await db.close()
  }
})

test("45. importación nueva: descuenta producto y variante, respeta reservas y hace rollback completo", async () => {
  const db = await setup()
  try {
    await importBatch(db, [sale(2, { quantity: 3 }), sale(3, { sku: "FUN-AZU", quantity: 2 })], "consume")
    assert.deepEqual(await stock(db), { ...BASE, aur: 7, funda: 6, azul: 1 })

    // Una reserva activa del checkout web no puede ser consumida por una venta externa.
    await db.query("insert into stock_reservations values ('web-session-1', 1, null, null, 6, now() + interval '10 minutes', null)")
    await assert.rejects(importBatch(db, [sale(2, { quantity: 2, customer_name: "Otro" })], "consume"), /EXTERNAL_SALE_STOCK_UNAVAILABLE: AUR-1 tiene 1 unidades disponibles/)
    // Una reserva vencida ya no bloquea.
    await db.query("update stock_reservations set expires_at = now() - interval '1 minute'")
    await importBatch(db, [sale(2, { quantity: 2, customer_name: "Otro" })], "consume")
    assert.equal((await stock(db)).aur, 5)

    // Una fila sin stock suficiente revierte toda la tanda: ni ventas, ni tanda, ni stock.
    const before = await one<{ sales: number; batches: number }>(db, "select (select count(*)::int from external_sales) sales, (select count(*)::int from external_sale_import_batches) batches")
    await assert.rejects(
      importBatch(db, [sale(2, { sku: "FUN-NEG", customer_name: "A" }), sale(3, { sku: "FUN-AZU", quantity: 2, customer_name: "B" })], "consume"),
      /EXTERNAL_SALE_STOCK_UNAVAILABLE: FUN-AZU tiene 1 unidades/,
    )
    assert.deepEqual(await one(db, "select (select count(*)::int from external_sales) sales, (select count(*)::int from external_sale_import_batches) batches"), before)
    assert.deepEqual(await stock(db), { ...BASE, aur: 5, funda: 6, azul: 1 })

    // Un SKU que ya no está en el catálogo no puede descontar stock; uno con variantes exige la variante.
    await assert.rejects(importBatch(db, [sale(2, { sku: "VIEJO-1" })], "consume"), /EXTERNAL_SALE_IMPORT_INVALID_ROW: fila 2: el SKU VIEJO-1 ya no está en el catálogo/)
    await assert.rejects(importBatch(db, [sale(7, { sku: "FUN" })], "none"), /fila 7: el SKU FUN es de un producto con variantes/)
    await assert.rejects(importBatch(db, [sale(8, { sku: "NO-EXISTE" })], "none"), /fila 8: el SKU NO-EXISTE no existe/)
    await assert.rejects(importBatch(db, [sale(9, { sale_date: "2999-01-01" })], "none"), /fila 9: la fecha de venta/)
    await assert.rejects(importBatch(db, [sale(9, { product_id: 1 })], "none"), /se identifica sólo por SKU/)
  } finally {
    await db.close()
  }
})

test("46. duplicados: idempotencia por tanda y advertencia confirmable para ventas idénticas", async () => {
  const db = await setup()
  try {
    const rows = [sale(2), sale(3, { customer_name: "Marta" })]
    const idempotencyKey = key("double-submit")
    const first = await importBatch(db, rows, "consume", idempotencyKey)
    const retry = await importBatch(db, rows, "consume", idempotencyKey)
    assert.equal(retry.batch_id, first.batch_id, "doble click / retry / refresh devuelven la misma tanda")
    assert.equal(retry.replayed, true)
    assert.equal((await one<{ n: number }>(db, "select count(*)::int n from external_sales")).n, 2)
    assert.equal((await stock(db)).aur, 8, "el retry no descuenta dos veces")
    await assert.rejects(importBatch(db, [sale(2, { quantity: 2 })], "consume", idempotencyKey), /IDEMPOTENCY_PAYLOAD_MISMATCH/)
    await assert.rejects(
      db.query("insert into external_sales (product_name, origin, import_batch_id, source_row_number, stock_effect) values ('x', 'paste', $1, 2, 'none')", [first.batch_id]),
      /external_sales_batch_row_uidx/,
      "misma tanda + misma fila no puede existir dos veces",
    )

    // Misma fecha, SKU, cliente, cantidad y precio: posible duplicada, no bloqueo definitivo.
    const preview = await one<{ r: { rows: Array<{ resolution: string; duplicate_sale_numbers: number[]; available_units: number }>; previous_batch: { id: string } | null } }>(
      db, "select public.preview_external_sales_import($1::jsonb) as r", [JSON.stringify(rows)],
    )
    assert.equal(preview.r.rows[0].resolution, "ok")
    assert.equal(preview.r.rows[0].duplicate_sale_numbers.length, 1)
    assert.equal(preview.r.rows[0].available_units, 8)
    assert.equal(preview.r.previous_batch?.id, first.batch_id, "la misma tanda ya fue importada")
    await assert.rejects(importBatch(db, [sale(2)], "none"), /EXTERNAL_SALE_POSSIBLE_DUPLICATE: la fila 2 parece repetida/)
    await assert.rejects(importBatch(db, [sale(2, { customer_name: "Nueva" }), sale(3, { customer_name: "Nueva" })], "none"), /la fila 3 parece repetida/)
    const confirmed = await importBatch(db, [sale(2, { confirm_duplicate: true }), sale(3, { confirm_duplicate: true })], "none")
    assert.equal(confirmed.imported, 2, "dos ventas legítimamente iguales pueden existir")
    const identical = await one<{ n: number }>(db, "select count(*)::int n from external_sales where customer_name = 'Cliente 2'")
    assert.equal(identical.n, 2)
  } finally {
    await db.close()
  }
})

test("47. edición: cantidad y SKU mueven stock sólo en ventas nuevas; versión y reintento", async () => {
  const db = await setup()
  try {
    await importBatch(db, [sale(2, { quantity: 2 })], "consume")
    const created = await saleBy(db, "source_row_number = 2 and stock_effect = 'consume'")
    assert.equal((await stock(db)).aur, 8)

    // A x2 -> A x1 devuelve una unidad.
    const edited = await update(db, created.id, 1, { quantity: 1, gross_amount: 7500 })
    assert.equal(edited.version, 2)
    assert.equal((await stock(db)).aur, 9)
    // A x1 -> B x1 devuelve A y consume B (variante).
    const moved = await update(db, created.id, 2, { sku: "FUN-NEG" })
    assert.deepEqual([moved.product_id, moved.variant_id, moved.sku], [2, 21, "FUN-NEG"])
    assert.deepEqual(await stock(db), { ...BASE, negra: 4, funda: 7 })
    const renamed = await one<{ product_name: string; costo: string }>(db, "select product_name, costo_unitario_historico::text costo from external_sales where id = $1", [created.id])
    assert.equal(renamed.product_name, "Funda Ñandú · Negra")
    assert.equal(renamed.costo, "1000.00", "el costo histórico se recalcula para el nuevo artículo")

    // Versión vieja: conflicto (dos administradores editando la misma venta).
    await assert.rejects(update(db, created.id, 2, { quantity: 2 }), /EXTERNAL_SALE_VERSION_CONFLICT/)
    // Reintento de una edición ya aplicada: no es conflicto ni vuelve a mover stock.
    const replay = await update(db, created.id, 2, { sku: "FUN-NEG" })
    assert.equal(replay.version, 3)
    assert.equal((await stock(db)).negra, 4)
    // Más unidades que las disponibles: rechazado.
    await assert.rejects(update(db, created.id, 3, { quantity: 6 }), /EXTERNAL_SALE_STOCK_UNAVAILABLE: FUN-NEG tiene 5 unidades/)
    await assert.rejects(update(db, created.id, 3, { stock_effect: "none" }), /el campo stock_effect no se puede editar/)
    await assert.rejects(db.query("update external_sales set stock_effect = 'none' where id = $1", [created.id]), /EXTERNAL_SALE_STOCK_EFFECT_IMMUTABLE/)

    // Histórica: cambiar SKU y cantidad no mueve stock.
    await importBatch(db, [sale(5, { customer_name: "Histórica" })], "none")
    const historical = await saleBy(db, "customer_name = 'Histórica'")
    const before = await stock(db)
    await update(db, historical.id, 1, { sku: "FUN-AZU", quantity: 3 })
    assert.deepEqual(await stock(db), before)
    const marked = await one<{ modified: boolean }>(db, "select modified_after_import_at is not null modified from external_sales where id = $1", [historical.id])
    assert.equal(marked.modified, true, "una venta importada editada queda marcada")
    const audit = await one<{ n: number }>(db, "select count(*)::int n from audit_logs where after_data ->> 'scope' = 'external_sale_edit' and actor_user_id = $1 and before_data is not null", [ADMIN])
    assert.equal(audit.n, 3)
  } finally {
    await db.close()
  }
})

test("48-49. anulación por error y devolución vendible/dañada", async () => {
  const db = await setup()
  try {
    await importBatch(db, [
      sale(2, { quantity: 2, customer_name: "Error" }),
      sale(3, { quantity: 1, customer_name: "Vendible" }),
      sale(4, { quantity: 1, customer_name: "Dañado" }),
    ], "consume")
    assert.equal((await stock(db)).aur, 6)
    const error = await saleBy(db, "customer_name = 'Error'")
    const cancelKey = key("cancel")
    const first = await cancel(db, error.id, "entry_error", null, cancelKey, 1)
    assert.equal(first.status, "reversed")
    assert.equal((await stock(db)).aur, 8, "cargada por error: devuelve el stock")
    const retry = await cancel(db, error.id, "entry_error", null, cancelKey)
    assert.equal(retry.reversed_at, first.reversed_at, "doble anulación con la misma clave es idempotente")
    assert.equal((await stock(db)).aur, 8)
    await assert.rejects(cancel(db, error.id, "entry_error", null), /EXTERNAL_SALE_ALREADY_REVERSED/)
    await assert.rejects(update(db, error.id, 2, { notes: "x" }), /EXTERNAL_SALE_ALREADY_REVERSED/)

    const sellable = await saleBy(db, "customer_name = 'Vendible'")
    await cancel(db, sellable.id, "return", "sellable")
    assert.equal((await stock(db)).aur, 9, "devolución vendible vuelve al stock")
    const damaged = await saleBy(db, "customer_name = 'Dañado'")
    const damagedResult = await cancel(db, damaged.id, "return", "damaged")
    assert.deepEqual([damagedResult.reversal_kind, damagedResult.return_condition], ["return", "damaged"])
    assert.equal((await stock(db)).aur, 9, "devolución dañada no vuelve al stock vendible")
    await assert.rejects(cancel(db, sellable.id, "return", null), /ALREADY_REVERSED|condición vendible/)

    // Históricas: ninguna anulación toca el stock actual.
    await importBatch(db, [sale(6, { customer_name: "H1" }), sale(7, { customer_name: "H2" })], "none")
    const before = await stock(db)
    await cancel(db, (await saleBy(db, "customer_name = 'H1'")).id, "entry_error", null)
    await cancel(db, (await saleBy(db, "customer_name = 'H2'")).id, "return", "sellable")
    assert.deepEqual(await stock(db), before)
    const scopes = (await db.query<{ scope: string; restored: boolean }>(
      "select after_data ->> 'scope' scope, (after_data ->> 'stock_restored')::boolean restored from audit_logs where after_data ->> 'scope' in ('external_sale_entry_error', 'external_sale_return') order by id",
    )).rows
    assert.deepEqual(scopes.map((row) => [row.scope, row.restored]), [
      ["external_sale_entry_error", true], ["external_sale_return", true], ["external_sale_return", false],
      ["external_sale_entry_error", false], ["external_sale_return", false],
    ])
    await assert.rejects(cancel(db, sellable.id, "otro", null), /tipo de anulación/)
  } finally {
    await db.close()
  }
})

test("50. deshacer tanda: histórica, nueva con varios productos, idempotencia, bloqueo y rollback", async () => {
  const db = await setup()
  try {
    const historical = await importBatch(db, [sale(2), sale(3, { customer_name: "B" })], "none")
    const revertSql = "select public.revert_external_sale_import_batch($1, $2, 'Tanda pegada dos veces por error', $3) as r"
    const revert = (batch: string, expected: number) => one<{ r: { reverted: number; status: string; replayed: boolean } }>(db, revertSql, [batch, expected, ADMIN]).then((row) => row.r)

    assert.equal((await revert(historical.batch_id, 2)).reverted, 2)
    assert.deepEqual(await stock(db), BASE)
    const replay = await revert(historical.batch_id, 2)
    assert.equal(replay.replayed, true, "deshacer dos veces no vuelve a tocar nada")
    const kept = await one<{ n: number; reversed: number }>(db, "select count(*)::int n, count(*) filter (where status = 'reversed' and reversal_kind = 'batch_undo')::int reversed from external_sales where import_batch_id = $1", [historical.batch_id])
    assert.deepEqual(kept, { n: 2, reversed: 2 }, "las ventas no se borran")

    const fresh = await importBatch(db, [
      sale(2, { quantity: 2, customer_name: "C" }), sale(3, { sku: "FUN-NEG", customer_name: "D" }), sale(4, { sku: "FUN-AZU", quantity: 2, customer_name: "E" }),
    ], "consume")
    assert.deepEqual(await stock(db), { ...BASE, aur: 8, funda: 5, negra: 4, azul: 1 })
    await assert.rejects(revert(fresh.batch_id, 2), /EXTERNAL_SALE_BATCH_CHANGED/)

    // Si una reversión falla a mitad de camino no queda nada a medias.
    await db.exec(`
      create function public.fail_batch_undo() returns trigger language plpgsql as $$
      begin
        if new.status = 'reversed' and new.source_row_number = 4 then raise exception 'FALLA_SIMULADA'; end if;
        return new;
      end $$;
      create trigger fail_batch_undo before update on public.external_sales for each row execute function public.fail_batch_undo();
    `)
    await assert.rejects(revert(fresh.batch_id, 3), /FALLA_SIMULADA/)
    assert.equal((await one<{ n: number }>(db, "select count(*)::int n from external_sales where import_batch_id = $1 and status = 'reversed'", [fresh.batch_id])).n, 0)
    assert.equal((await one<{ status: string }>(db, "select status from external_sale_import_batches where id = $1", [fresh.batch_id])).status, "completed")
    assert.deepEqual(await stock(db), { ...BASE, aur: 8, funda: 5, negra: 4, azul: 1 })
    await db.exec("drop trigger fail_batch_undo on public.external_sales")

    assert.equal((await revert(fresh.batch_id, 3)).reverted, 3)
    assert.deepEqual(await stock(db), BASE, "la tanda nueva devuelve todo el stock")

    // Una tanda con una venta editada después no se deshace en bloque.
    const edited = await importBatch(db, [sale(2, { customer_name: "F" }), sale(3, { customer_name: "G" })], "consume")
    const target = await saleBy(db, "customer_name = 'F'")
    await update(db, target.id, 1, { notes: "Retiró en el local" })
    await assert.rejects(revert(edited.batch_id, 2), /EXTERNAL_SALE_BATCH_HAS_MODIFIED_SALES: 1 ventas/)
    assert.equal((await one<{ n: number }>(db, "select count(*)::int n from external_sales where import_batch_id = $1 and status = 'reversed'", [edited.batch_id])).n, 0)
    const audit = await one<{ n: number }>(db, "select count(*)::int n from audit_logs where after_data ->> 'scope' = 'external_sale_import_revert'")
    assert.equal(audit.n, 2)
  } finally {
    await db.close()
  }
})

test("alta manual: idempotente, Nueva descuenta respetando reservas, Histórica no; permisos en la RPC", async () => {
  const db = await setup()
  try {
    const payload = {
      sale_date: "2026-10-01", sku: "FUN-AZU", quantity: 2, gross_amount: 20000, shipping_amount: 1500,
      channel: "instagram", payment_method: "Mercado Pago", payment_method_code: "mercadopago",
      customer_name: "Ñoño Gómez", stock_effect: "consume", status: "completed", declared_profit: null,
    }
    const create = (body: Row, idempotencyKey: string, actor = ADMIN) => one<{ r: Row }>(
      db, "select to_jsonb(public.create_external_sale_idempotent($1::jsonb, $2, $3)) as r", [JSON.stringify(body), actor, idempotencyKey],
    ).then((row) => row.r)
    const createKey = key("manual")
    const created = await create(payload, createKey)
    assert.equal(created.product_name, "Funda Ñandú · Azul")
    assert.equal(created.unit_price, 10000)
    assert.equal(created.net_amount, 18500)
    assert.equal(created.origin, "manual")
    assert.equal((await stock(db)).azul, 1)
    assert.equal((await create(payload, createKey)).id, created.id, "el reintento devuelve la misma venta")
    assert.equal((await stock(db)).azul, 1)
    await assert.rejects(create({ ...payload, quantity: 1 }, createKey), /IDEMPOTENCY_PAYLOAD_MISMATCH/)

    await db.query("insert into stock_reservations values ('web-2', 2, 22, null, 1, now() + interval '5 minutes', null)")
    await assert.rejects(create({ ...payload, quantity: 1 }, key("manual")), /FUN-AZU tiene 0 unidades disponibles/)
    const historical = await create({ ...payload, stock_effect: "none" }, key("manual"))
    assert.equal(historical.stock_effect, "none")
    assert.equal((await stock(db)).azul, 1)
    await assert.rejects(create({ ...payload, stock_effect: undefined }, key("manual")), /histórica o nueva/)

    await assert.rejects(create(payload, key("manual"), OPERATOR), /FORBIDDEN/)
    await assert.rejects(importBatch(db, [sale(2)], "none", key("import"), OPERATOR), /FORBIDDEN/)
    await db.query("select set_config('request.jwt.claim.role', 'authenticated', false)")
    await assert.rejects(importBatch(db, [sale(2)], "none"), /FORBIDDEN/, "fuera de service_role la RPC rechaza aunque el actor sea admin")
    await db.query("select set_config('request.jwt.claim.role', '', false)")

    const privileges = await one<Row>(db, `
      select
        has_function_privilege('authenticated', 'public.import_external_sales_batch(jsonb, jsonb, uuid, text)', 'EXECUTE') import_auth,
        has_function_privilege('authenticated', 'public.update_external_sale(uuid, integer, jsonb, uuid, text)', 'EXECUTE') update_auth,
        has_function_privilege('authenticated', 'public.cancel_external_sale(uuid, text, text, text, uuid, text, integer)', 'EXECUTE') cancel_auth,
        has_function_privilege('authenticated', 'public.revert_external_sale_import_batch(uuid, integer, text, uuid)', 'EXECUTE') revert_auth,
        has_function_privilege('anon', 'public.preview_external_sales_import(jsonb)', 'EXECUTE') preview_anon,
        has_function_privilege('service_role', 'public.import_external_sales_batch(jsonb, jsonb, uuid, text)', 'EXECUTE') import_service,
        has_table_privilege('authenticated', 'public.external_sale_import_batches', 'SELECT') batches_auth,
        has_function_privilege('authenticated', 'public.external_sale_consumes_stock(text, text, text, text)', 'EXECUTE') view_helper_auth
    `)
    assert.deepEqual(privileges, {
      import_auth: false, update_auth: false, cancel_auth: false, revert_auth: false, preview_anon: false,
      import_service: true, batches_auth: false, view_helper_auth: true,
    })
  } finally {
    await db.close()
  }
})

test("51. ventas externas no crean pedidos web, pagos ni eventos de analítica", async () => {
  const db = await setup()
  try {
    await importBatch(db, [sale(2)], "consume")
    const counts = await one<Row>(db, "select (select count(*)::int from ordenes) orders, (select count(*)::int from orden_items) items")
    assert.deepEqual(counts, { orders: 0, items: 0 })
  } finally {
    await db.close()
  }
  const migration = read(MIGRATION)
  assert.doesNotMatch(migration, /insert into public\.(ordenes|orden_items|analytics_\w+|mercadopago\w*)/i)
  assert.doesNotMatch(migration, /delete from public\.external_sales/i, "las ventas nunca se borran físicamente")
})
