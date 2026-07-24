export interface ProductCostLedgerRow {
  product_id: number | null
  variant_id: number | null
  purchase_date: string
  quantity: number
  total_cost: number
}

interface ProductCostLedgerPoint {
  date: number
  quantity: number
  cost: number
}

export type ProductCostLedgers = Map<string, ProductCostLedgerPoint[]>

export function buildProductCostLedgers(rows: ProductCostLedgerRow[]) {
  const grouped = new Map<string, ProductCostLedgerRow[]>()

  rows.forEach((row) => {
    if (row.product_id == null) return
    const key = row.variant_id ? `v:${row.variant_id}` : `p:${row.product_id}`
    const values = grouped.get(key) ?? []
    values.push(row)
    grouped.set(key, values)
  })

  const ledgers: ProductCostLedgers = new Map()
  grouped.forEach((values, key) => {
    let quantity = 0
    let cost = 0
    const points = values
      .sort((a, b) => a.purchase_date.localeCompare(b.purchase_date))
      .map((row) => {
        quantity += Number(row.quantity ?? 0)
        cost += Number(row.total_cost ?? 0)
        return {
          date: new Date(`${row.purchase_date}T00:00:00-03:00`).getTime(),
          quantity,
          cost,
        }
      })
    ledgers.set(key, points)
  })

  return ledgers
}

export function getHistoricalUnitCost(
  ledgers: ProductCostLedgers,
  productId: number,
  variantId: number | null | undefined,
  saleDate: string,
) {
  const timestamp = new Date(saleDate).getTime()
  if (!Number.isFinite(timestamp)) return null

  const keys = variantId ? [`v:${variantId}`, `p:${productId}`] : [`p:${productId}`]

  for (const key of keys) {
    const points = ledgers.get(key)
    if (!points?.length) continue

    let low = 0
    let high = points.length - 1
    let match: ProductCostLedgerPoint | null = null

    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      if (points[middle].date <= timestamp) {
        match = points[middle]
        low = middle + 1
      } else {
        high = middle - 1
      }
    }

    if (match?.quantity) return match.cost / match.quantity
  }

  return null
}
