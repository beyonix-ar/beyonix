// PostgREST en memoria para los tests de Compras: misma forma de consulta que
// supabase-js y, como Supabase, nunca devuelve más de MAX_ROWS filas por
// respuesta. Así un recorrido que dependa de "una sola página" falla en test.
export const MAX_ROWS = 1000

export type FakeProduct = {
  id: number
  nombre: string
  activo?: boolean
  stock?: number | null
  sku?: string | null
  codigo_barra?: string | null
}
export type FakeVariant = {
  id: number
  producto_id: number
  nombre: string
  activo?: boolean
  stock?: number | null
  sku?: string | null
  color_hex?: string | null
  codigo_barra?: string | null
}
export type FakePurchase = {
  id: string
  product_id: number | null
  variant_id: number | null
  article_name?: string | null
  sku?: string | null
  purchase_date?: string
  quantity?: number
  unit_cost?: number
  total_cost?: number
  created_at?: string
}

type Row = Record<string, unknown>
type Filter = (row: Row) => boolean
type Order = { column: string; ascending: boolean }

export type FakeDbData = {
  productos: FakeProduct[]
  producto_variantes: FakeVariant[]
  product_cost_entries: FakePurchase[]
}

export type FakeDb = ReturnType<typeof createFakeCostCatalogDb>

const compare = (left: unknown, right: unknown) => {
  if (left == null && right == null) return 0
  if (left == null) return 1
  if (right == null) return -1
  if (typeof left === "number" && typeof right === "number") return left - right
  return String(left).localeCompare(String(right), "es", { sensitivity: "base", numeric: true })
}

export function createFakeCostCatalogDb(data: FakeDbData) {
  const requests: string[] = []
  const product = (id: unknown) => data.productos.find((item) => item.id === id) ?? null
  const variant = (id: unknown) => data.producto_variantes.find((item) => item.id === id) ?? null
  const normalizedBarcode = (value: string | null | undefined) => value?.trim() || null
  const normalizedSku = (value: string | null | undefined) => value?.trim().toUpperCase() || null

  const variantRow = (item: FakeVariant) => ({
    activo: true,
    stock: null,
    sku: null,
    color_hex: null,
    codigo_barra: null,
    ...item,
  })

  const tables: Record<string, () => Row[]> = {
    productos: () =>
      data.productos.map((item) => ({
        activo: true,
        stock: null,
        sku: null,
        codigo_barra: null,
        ...item,
        producto_variantes: data.producto_variantes.filter((v) => v.producto_id === item.id).map(variantRow),
        product_cost_entries: data.product_cost_entries.filter((entry) => entry.product_id === item.id),
      })),
    producto_variantes: () =>
      data.producto_variantes.map((item) => ({
        ...variantRow(item),
        productos: product(item.producto_id),
        product_cost_entries: data.product_cost_entries.filter((entry) => entry.variant_id === item.id),
      })),
    product_cost_entries: () =>
      data.product_cost_entries.map((item) => ({
        ...item,
        productos: product(item.product_id),
        producto_variantes: variant(item.variant_id),
      })),
    catalog_barcode_registry: () => [
      ...data.productos.flatMap((item) =>
        normalizedBarcode(item.codigo_barra) ? [{ normalized_barcode: normalizedBarcode(item.codigo_barra), product_id: item.id, variant_id: null }] : [],
      ),
      ...data.producto_variantes.flatMap((item) =>
        normalizedBarcode(item.codigo_barra) ? [{ normalized_barcode: normalizedBarcode(item.codigo_barra), product_id: null, variant_id: item.id }] : [],
      ),
    ],
    catalog_sku_registry: () => [
      ...data.productos.flatMap((item) =>
        normalizedSku(item.sku) ? [{ normalized_sku: normalizedSku(item.sku), product_id: item.id, variant_id: null }] : [],
      ),
      ...data.producto_variantes.flatMap((item) =>
        normalizedSku(item.sku) ? [{ normalized_sku: normalizedSku(item.sku), product_id: null, variant_id: item.id }] : [],
      ),
    ],
  }

  class Query {
    private filters: Filter[] = []
    private orders: Order[] = []
    private from = 0
    private to = Number.POSITIVE_INFINITY
    private single = false
    private head = false
    private table: string
    constructor(table: string, head: boolean) {
      this.table = table
      this.head = head
    }
    eq(column: string, value: unknown) { this.filters.push((row) => row[column] === value); return this }
    neq(column: string, value: unknown) { this.filters.push((row) => row[column] !== value); return this }
    in(column: string, values: unknown[]) { this.filters.push((row) => values.includes(row[column])); return this }
    is(column: string, value: null) {
      this.filters.push((row) => {
        const cell = row[column]
        return Array.isArray(cell) ? cell.length === 0 : cell === value || cell === undefined
      })
      return this
    }
    not(column: string, operator: "is", value: null) {
      this.filters.push((row) => row[column] !== value && row[column] !== undefined)
      return this
    }
    filter(column: string, operator: "imatch", pattern: string) {
      const regex = new RegExp(pattern, "iu")
      this.filters.push((row) => typeof row[column] === "string" && regex.test(row[column] as string))
      return this
    }
    order(column: string, options: { ascending?: boolean; referencedTable?: string } = {}) {
      if (!options.referencedTable) this.orders.push({ column, ascending: options.ascending !== false })
      return this
    }
    range(from: number, to: number) { this.from = from; this.to = to; return this }
    limit(count: number) { this.to = this.from + count - 1; return this }
    maybeSingle() { this.single = true; return this }
    private run() {
      requests.push(this.table)
      const rows = tables[this.table]().filter((row) => this.filters.every((filter) => filter(row)))
      rows.sort((left, right) => {
        for (const { column, ascending } of this.orders) {
          const result = compare(left[column], right[column])
          if (result) return ascending ? result : -result
        }
        return 0
      })
      if (this.head) return { data: null, error: null, count: rows.length }
      const page = rows.slice(this.from, Math.min(this.to + 1, this.from + MAX_ROWS))
      if (this.single) {
        if (page.length > 1) return { data: null, error: { message: "multiple rows" }, count: null }
        return { data: page[0] ?? null, error: null, count: null }
      }
      return { data: page, error: null, count: null }
    }
    then<TResult>(resolve: (value: { data: unknown; error: { message: string } | null; count: number | null }) => TResult) {
      return Promise.resolve(this.run()).then(resolve)
    }
  }

  return {
    requests,
    from(table: string) {
      if (!tables[table]) throw new Error(`Tabla no simulada: ${table}`)
      return {
        select: (_fields: string, options: { head?: boolean } = {}) => new Query(table, options.head === true),
      }
    },
  }
}
