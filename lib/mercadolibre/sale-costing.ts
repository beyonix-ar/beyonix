export interface MercadoLibreCostMapping {
  product_id: number | null
  variant_id: number | null
  standalone_key: string | null
  match_key: string
}

function number(value: unknown) {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

function normalizedText(value: unknown) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
}

function rawObject(value: unknown) {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {}
}

export function getMercadoLibreCostMapping(
  row: Record<string, unknown>,
): MercadoLibreCostMapping | null {
  const raw = rawObject(row.raw_data)
  const storedMapping = rawObject(raw.beyonix_cost_mapping)
  const standaloneKey =
    typeof storedMapping.standalone_key === "string"
      ? storedMapping.standalone_key
      : null
  const productId = number(storedMapping.product_id || row.product_id)
  const validProductId =
    Number.isInteger(productId) && productId > 0 ? productId : null

  if (!validProductId && !standaloneKey) return null

  const variantId = number(storedMapping.variant_id)
  return {
    product_id: validProductId,
    variant_id:
      validProductId && Number.isInteger(variantId) && variantId > 0
        ? variantId
        : null,
    standalone_key: standaloneKey,
    match_key:
      typeof storedMapping.match_key === "string"
        ? storedMapping.match_key
        : row.sku
          ? `sku:${String(row.sku)}`
          : `product:${String(row.product_name ?? "")}`,
  }
}

export interface MercadoLibrePhysicalReview {
  sellableQuantity: number
  discountedQuantity: number
  nonSellableQuantity: number
}

/**
 * Auditoría 5/7 (P1): review_mercadolibre_return ya clasifica físicamente
 * cada devolución (sellable/discounted/no vendible, ver
 * inventory_return_movements), pero el costeo del dashboard sólo miraba el
 * status/return_units autoreportado por Mercado Libre -- todo o nada, sin
 * distinguir una unidad que volvió a stock vendible (costo recuperado) de
 * una dada de baja (costo no recuperado). Cuando existe una revisión física
 * real para la venta, prevalece sobre el autoreporte: sellable + discounted
 * son costo recuperado (misma semántica que restockedQuantity en
 * devoluciones web -- discounted también recupera costo porque pasa a stock
 * condicionado para reventa, no se pierde), sólo non_sellable se mantiene
 * costeable.
 */
export function getMercadoLibreCostableUnits(
  row: Record<string, unknown>,
  physicalReview?: MercadoLibrePhysicalReview | null,
) {
  const quantity = Math.max(0, Math.trunc(number(row.quantity)))

  if (physicalReview) {
    const recoveredUnits = Math.min(
      quantity,
      Math.max(0, physicalReview.sellableQuantity) +
        Math.max(0, physicalReview.discountedQuantity),
    )
    return Math.max(0, quantity - recoveredUnits)
  }

  const parsed = rawObject(rawObject(row.raw_data).parsed)
  const status = normalizedText(parsed.status)
  const cancelled = status.includes("cancel") || status.includes("anulad")

  if (cancelled) return 0

  const returned =
    status.includes("devol") ||
    status.includes("reembolso") ||
    number(parsed.cancellations_refunds) < 0 ||
    Boolean(String(parsed.return_tracking_number ?? "").trim()) ||
    Boolean(String(parsed.return_result ?? "").trim())
  const reportedReturnedUnits = Math.max(
    0,
    Math.trunc(number(parsed.return_units)),
  )
  const returnedUnits = returned
    ? reportedReturnedUnits || quantity
    : reportedReturnedUnits

  return Math.max(0, quantity - Math.min(quantity, returnedUnits))
}

export function getMercadoLibreRefundAmount(
  row: Record<string, unknown>,
) {
  const parsed = rawObject(rawObject(row.raw_data).parsed)
  return Math.abs(Math.min(number(parsed.cancellations_refunds), 0))
}

export interface MercadoLibreCostingSummaryRow {
  net_amount: unknown
  costing?: {
    costable_units?: unknown
    merchandise_cost?: number | null
  } | null
}

export interface MercadoLibreCostingSummary {
  totalCostableUnits: number
  coveredUnits: number
  merchandiseCost: number
  /** true cuando el costo de mercadería ya se conoce para el 100% de las filas. */
  exact: boolean
  /** true cuando hay ganancia calculable pero todavía quedan filas sin costo. */
  isPartial: boolean
  /**
   * Ganancia acumulada de las filas con costo histórico ya conocido
   * (ingresos netos - costo de mercadería, ambos limitados a esas filas).
   * null únicamente cuando ninguna fila tiene costo determinado todavía:
   * las unidades pendientes nunca se computan con costo 0 ni invalidan
   * la porción ya conocida.
   */
  profit: number | null
}

/**
 * Resume la rentabilidad de ventas de Mercado Libre con la información
 * disponible hasta el momento. Cada fila aporta su ganancia sólo si su
 * costo histórico de mercadería ya se determinó (ver getHistoricalUnitCost /
 * getStandaloneHistoricalUnitCost); las filas pendientes se cuentan pero no
 * se mezclan en el cálculo. El resultado se recalcula solo apenas una fila
 * antes pendiente pasa a tener `merchandise_cost` no nulo.
 */
export function summarizeMercadoLibreCosting(
  rows: MercadoLibreCostingSummaryRow[],
  costingError: boolean = false,
): MercadoLibreCostingSummary {
  let totalCostableUnits = 0
  let coveredUnits = 0
  let merchandiseCost = 0
  let coveredRevenue = 0
  let coveredRows = 0

  rows.forEach((row) => {
    const units = number(row.costing?.costable_units)
    totalCostableUnits += units

    if (row.costing?.merchandise_cost == null) return

    coveredUnits += units
    merchandiseCost += number(row.costing.merchandise_cost)
    coveredRevenue += number(row.net_amount)
    coveredRows += 1
  })

  const exact = !costingError && coveredRows === rows.length
  const hasKnownCost = !costingError && coveredRows > 0

  return {
    totalCostableUnits,
    coveredUnits,
    merchandiseCost,
    exact,
    isPartial: hasKnownCost && !exact,
    profit: hasKnownCost ? coveredRevenue - merchandiseCost : null,
  }
}
