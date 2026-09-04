/** Estados reales de `product_cost_entries.reception_status` (ver migración 20260801093000). */
export type ProductCostReceptionStatus =
  | "pendiente"
  | "parcial"
  | "recibida"
  | "anulada"

export interface ProductCostLedgerRow {
  product_id: number | null
  variant_id: number | null
  purchase_date: string
  quantity: number
  /** Unidades efectivamente recibidas. `null` en filas históricas previas a la columna. */
  received_quantity: number | null
  /** `null` se interpreta como 'recibida' (default NOT NULL de la tabla). */
  reception_status: string | null
  total_cost: number
}

interface ProductCostLedgerPoint {
  date: number
  quantity: number
  cost: number
}

export type ProductCostLedgers = Map<string, ProductCostLedgerPoint[]>

/**
 * Parte de una compra que representa mercadería REALMENTE incorporada al
 * inventario, que es la única que puede formar el costo usado para fijar
 * precio. Sigue exactamente el mismo criterio que la vista canónica
 * `inventory_movements` (migración 20260801104000), que proyecta stock a
 * partir de `received_quantity` -- no de `quantity`.
 *
 * - `anulada` / `pendiente`: no entró nada, no aporta ni unidades ni costo.
 * - `parcial`: aporta las unidades recibidas y la parte proporcional del
 *   costo total (el componente unitario escala exacto; fletes, impuestos y
 *   comisiones se prorratean, que es lo más cercano a la realidad sin
 *   inventar un criterio de imputación nuevo).
 * - `recibida`: aporta la compra completa (comportamiento histórico).
 *
 * Devuelve `null` cuando la fila no aporta nada al costo. Nunca inventa
 * costos ni asume 0 como "costo conocido".
 */
export function getReceivedCostContribution(row: ProductCostLedgerRow) {
  const quantity = Number(row.quantity ?? 0)
  if (!Number.isFinite(quantity) || quantity <= 0) return null

  const status = (row.reception_status ?? "recibida") as ProductCostReceptionStatus
  if (status === "anulada" || status === "pendiente") return null

  const declaredReceived =
    status === "recibida"
      ? quantity
      : Number(row.received_quantity ?? 0)
  const received = Math.min(
    Math.max(Number.isFinite(declaredReceived) ? declaredReceived : 0, 0),
    quantity,
  )
  if (received <= 0) return null

  const totalCost = Number(row.total_cost ?? 0)
  if (!Number.isFinite(totalCost)) return null

  return {
    quantity: received,
    cost: received === quantity ? totalCost : (totalCost * received) / quantity,
  }
}

export function buildProductCostLedgers(rows: ProductCostLedgerRow[]) {
  const grouped = new Map<string, ProductCostLedgerRow[]>()

  rows.forEach((row) => {
    if (row.product_id == null) return
    if (!getReceivedCostContribution(row)) return
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
        const contribution = getReceivedCostContribution(row)!
        quantity += contribution.quantity
        cost += contribution.cost
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

/** Nombre legible de una variante para mensajes de Admin. */
export function getVariantCostLabel(resolution: VariantCostResolution) {
  return resolution.variantName?.trim() || `Variante #${resolution.variantId}`
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

export type TargetMarginCostBasis =
  | { ok: true; cost: number }
  | { ok: false; reason: "no_cost"; missing: VariantCostResolution[] }
  | { ok: false; reason: "missing_variant_cost"; missing: VariantCostResolution[] }

/**
 * Base de costo válida para calcular un precio por MARGEN OBJETIVO.
 *
 * `getWorstCaseKnownCost` sirve para mostrar el peor costo conocido, pero no
 * alcanza para fijar precio: si el producto tiene varias variantes vendibles
 * y alguna NO tiene costo cargado, el "peor caso" entre las conocidas puede
 * ser muy inferior al real y el precio resultante garantizaría un margen que
 * no existe. En ese caso hay que BLOQUEAR el cálculo automático -- nunca
 * inventar, asumir 0 ni promediar. El precio manual sigue disponible.
 *
 * `resolutions` debe contener únicamente las variantes RELEVANTES (las que
 * van a quedar activas/vendibles); una variante desactivada no puede venderse
 * y por lo tanto no condiciona el precio.
 */
export function resolveTargetMarginCostBasis(
  resolutions: VariantCostResolution[],
): TargetMarginCostBasis {
  const missing = resolutions.filter((entry) => entry.unitCost == null)
  const cost = getWorstCaseKnownCost(resolutions)

  if (cost == null) return { ok: false, reason: "no_cost", missing }
  if (missing.length > 0) {
    return { ok: false, reason: "missing_variant_cost", missing }
  }

  return { ok: true, cost }
}

/** Mensaje de Admin para una base de costo insuficiente. Nunca expone datos al cliente. */
export function getTargetMarginCostBasisError(
  basis: Exclude<TargetMarginCostBasis, { ok: true }>,
) {
  if (basis.reason === "no_cost") {
    return "Costo desconocido: cargá un costo de compra para este producto en Admin > Costos antes de usar margen objetivo."
  }

  return `No se puede calcular el margen objetivo porque existen variantes sin costo conocido: ${basis.missing
    .map(getVariantCostLabel)
    .join(", ")}. Cargá su costo de compra en Admin > Costos o usá precio manual.`
}
