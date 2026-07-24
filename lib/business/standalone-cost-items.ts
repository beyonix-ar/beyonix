export interface StandaloneCostRow {
  id: string
  product_id: number | null
  article_name: string | null
  sku: string | null
  purchase_date: string
  quantity: number
  total_cost: number
  created_at?: string | null
}

export interface StandaloneCostItem {
  key: string
  nombre: string
  sku: string | null
  unit_cost: number
}

export function normalizeCatalogText(value: unknown) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLocaleLowerCase("es")
}

export function standaloneCostKey(row: Pick<StandaloneCostRow, "article_name" | "sku">) {
  const name = normalizeCatalogText(row.article_name)
  if (name) return `name:${name}`
  const sku = normalizeCatalogText(row.sku)
  return sku ? `sku:${sku}` : ""
}

export function buildStandaloneCostItems(rows: StandaloneCostRow[]) {
  const grouped = new Map<string, StandaloneCostRow[]>()

  rows.forEach((row) => {
    if (row.product_id != null || !row.article_name?.trim()) return
    const key = standaloneCostKey(row)
    if (!key) return
    const values = grouped.get(key) ?? []
    values.push(row)
    grouped.set(key, values)
  })

  return [...grouped.entries()]
    .map(([key, values]) => {
      const latest = [...values].sort((a, b) => {
        const dateComparison = b.purchase_date.localeCompare(a.purchase_date)
        if (dateComparison) return dateComparison
        return String(b.created_at ?? "").localeCompare(String(a.created_at ?? ""))
      })[0]
      const quantity = Number(latest.quantity)
      const totalCost = Number(latest.total_cost)
      return {
        key,
        nombre: latest.article_name?.trim() ?? "Artículo sin nombre",
        sku: latest.sku?.trim() || null,
        unit_cost:
          Number.isFinite(quantity) && quantity > 0 && Number.isFinite(totalCost)
            ? Math.round((totalCost / quantity) * 100) / 100
            : 0,
      } satisfies StandaloneCostItem
    })
    .sort((a, b) => a.nombre.localeCompare(b.nombre, "es", { sensitivity: "base" }))
}

export function getStandaloneHistoricalUnitCost(
  rows: StandaloneCostRow[],
  key: string,
  saleDate: string,
) {
  const timestamp = new Date(saleDate).getTime()
  if (!Number.isFinite(timestamp)) return null

  let quantity = 0
  let cost = 0
  const eligible = rows
    .filter(
      (row) =>
        row.product_id == null &&
        standaloneCostKey(row) === key &&
        new Date(`${row.purchase_date}T00:00:00-03:00`).getTime() <= timestamp,
    )
    .sort((a, b) => a.purchase_date.localeCompare(b.purchase_date))

  eligible.forEach((row) => {
    quantity += Number(row.quantity ?? 0)
    cost += Number(row.total_cost ?? 0)
  })

  return quantity > 0 ? cost / quantity : null
}
