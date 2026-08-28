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

export interface ProductVariantSummary {
  id: number
  nombre?: string | null
}

export interface VariantCostResolution {
  /** `null` sólo para un producto SIN variantes (costo a nivel producto). */
  variantId: number | null
  variantName: string | null
  unitCost: number | null
}

/**
 * Resuelve el costo histórico de un producto contemplando sus variantes.
 *
 * Un producto CON variantes nunca se compra "a nivel producto" -- cada
 * compra se carga contra una variante puntual (ver Admin > Costos), así que
 * `variant_id` en `product_cost_entries` es la referencia real. Pasar
 * `variantId: null` (costo a nivel producto) para un producto con variantes
 * nunca encuentra esas compras -- hay que resolver el costo de CADA variante
 * por separado, nunca colapsar variantes con costos distintos en un único
 * número inventado.
 *
 * - Sin variantes: una sola resolución a nivel producto (comportamiento
 *   histórico, sin cambios).
 * - Con una o más variantes: una resolución por variante, cada una usando
 *   `getHistoricalUnitCost` (que ya hace fallback a nivel producto si esa
 *   variante puntual no tiene compras propias cargadas).
 */
export function resolveProductVariantCosts(
  ledgers: ProductCostLedgers,
  productId: number,
  variants: ProductVariantSummary[],
  saleDate: string,
): VariantCostResolution[] {
  if (variants.length === 0) {
    return [
      {
        variantId: null,
        variantName: null,
        unitCost: getHistoricalUnitCost(ledgers, productId, null, saleDate),
      },
    ]
  }

  return variants.map((variant) => ({
    variantId: variant.id,
    variantName: variant.nombre ?? null,
    unitCost: getHistoricalUnitCost(ledgers, productId, variant.id, saleDate),
  }))
}

/**
 * Costo de referencia para fijar precio: el MAYOR costo conocido entre las
 * resoluciones (peor caso). Mismo principio que el peor escenario de medio
 * de pago (lib/pricing/product-pricing.ts) -- un precio único para todas las
 * variantes debe garantizar el margen incluso en la variante más cara de
 * reponer, nunca menos. `null` si ninguna resolución tiene costo conocido.
 */
export function getWorstCaseKnownCost(
  resolutions: VariantCostResolution[],
): number | null {
  const knownCosts = resolutions
    .map((entry) => entry.unitCost)
    .filter((cost): cost is number => cost != null)

  return knownCosts.length > 0 ? Math.max(...knownCosts) : null
}
