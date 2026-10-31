import assert from "node:assert/strict"
import test from "node:test"

import { getCanonicalCatalogSku } from "./sku-aliases.ts"
import { buildUniqueCatalogTargetsBySku, reconcileUnlinkedMercadoLibreSalesByExactSku } from "./sku-reconciliation.ts"

type Row = Record<string, unknown>
type Filter = (row: Row) => boolean

/** Cliente mínimo en memoria: aplica los filtros reales que arma la conciliación. */
function fakeAdmin(tables: Record<string, Row[]>) {
  const updates: Array<{ id: unknown; values: Row }> = []
  function builder(table: string, mode: { update?: Row; head?: boolean } = {}) {
    const filters: Filter[] = []
    const chain = {
      select: (_columns: string, options?: { head?: boolean }) => builder(table, { ...mode, head: options?.head }),
      update: (values: Row) => builder(table, { update: values }),
      is: (column: string, value: null) => (filters.push((row) => (row[column] ?? null) === value), chain),
      eq: (column: string, value: unknown) => (filters.push((row) => row[column] === value), chain),
      not: (column: string) => (filters.push((row) => row[column] != null), chain),
      order: () => chain,
      range: () => chain,
      then: (resolve: (value: unknown) => void) => {
        const rows = (tables[table] ?? []).filter((row) => filters.every((filter) => filter(row)))
        if (mode.update) {
          for (const row of rows) {
            Object.assign(row, mode.update)
            updates.push({ id: row.id, values: mode.update })
          }
          return resolve({ data: null, error: null })
        }
        return resolve({ data: mode.head ? null : rows, count: rows.length, error: null })
      },
    }
    return chain
  }
  return { client: { from: (table: string) => builder(table) }, updates }
}

test("la conciliación automática sólo vincula ventas sin efecto en stock", async () => {
  const sales: Row[] = [
    { id: "none-1", sku: "AP01", product_id: null, stock_effect: "none", raw_data: { parsed: {} } },
    { id: "consume-legacy", sku: "AP01", product_id: null, stock_effect: "consume", raw_data: { parsed: {} } },
  ]
  const { client, updates } = fakeAdmin({ productos: [{ id: 10, sku: "AP01", producto_variantes: [] }], mercadolibre_sales: sales })

  const first = await reconcileUnlinkedMercadoLibreSalesByExactSku(client as never, { actorId: "admin" })
  assert.deepEqual(first, { linked: 1, errors: [] })
  assert.deepEqual(updates.map((update) => update.id), ["none-1"])
  assert.equal(sales[1].product_id, null, "la venta consume legada no se vincula sola: eso movería stock")

  // Repetir no vuelve a tocar nada (idempotente).
  const second = await reconcileUnlinkedMercadoLibreSalesByExactSku(client as never, { actorId: "admin" })
  assert.deepEqual(second, { linked: 0, errors: [] })
  assert.equal(updates.length, 1)
})

test("vincula un SKU exacto sin importar espacios o mayúsculas", () => {
  const targets = buildUniqueCatalogTargetsBySku([
    {
      id: 63,
      sku: " AP01 ",
      producto_variantes: [],
    },
  ])

  assert.deepEqual(targets.get("AP01"), {
    productId: 63,
    variantId: null,
  })
})

test("no vincula automáticamente un SKU ambiguo", () => {
  const targets = buildUniqueCatalogTargetsBySku([
    { id: 1, sku: "DUP01", producto_variantes: [] },
    { id: 2, sku: "dup01", producto_variantes: [] },
  ])

  assert.equal(targets.has("DUP01"), false)
})

test("los productos con variantes se vinculan por el SKU de la variante", () => {
  const targets = buildUniqueCatalogTargetsBySku([
    {
      id: 8,
      sku: "PRODUCTO-GENERAL",
      producto_variantes: [{ id: 21, sku: "VARIANTE-01" }],
    },
  ])

  assert.equal(targets.has("PRODUCTO-GENERAL"), false)
  assert.deepEqual(targets.get("VARIANTE-01"), {
    productId: 8,
    variantId: 21,
  })
})

test("un SKU viejo de mate no se trata como equivalente al SKU nuevo", () => {
  assert.equal(getCanonicalCatalogSku("MATEINOXROSA001"), "MATEINOXROSA001")
  assert.notEqual(getCanonicalCatalogSku("MATEINOXROSA001"), "MTR01")
})
