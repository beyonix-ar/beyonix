/**
 * Semántica financiera única de una línea comercial del Dashboard, igual
 * para Web, Mercado Libre y Ventas externas:
 *
 *   facturación (grossAmount) = bruto − reversiones (reintegros, NC, anulaciones)
 *   neto (netAmount)          = facturación − comisiones − logística absorbida − otros directos
 *   resultado (profitAmount)  = neto − costo de mercadería
 *
 * El backend arma cada línea con estas funciones; el panel sólo filtra,
 * agrupa y suma (summarizeSaleFinancials). Los gastos generales nunca entran
 * acá: se restan aparte (calculateOperatingResult).
 */

/**
 * De dónde sale el costo de mercadería de la línea.
 * snapshot: congelado en la venta. historical: libro de compras a la fecha
 * de la venta. manual: cargado a mano en una venta externa sin producto.
 * inferred: deducido de la ganancia declarada (no es un costo de compra).
 * missing: no determinable. none: la línea no tiene unidades que costear.
 */
export type SaleCostSource =
  | "snapshot"
  | "historical"
  | "manual"
  | "inferred"
  | "missing"
  | "none"

export interface SaleFinancials {
  /** Monto bruto comercial original de la venta. */
  grossSales: number
  /**
   * Reintegros, notas de crédito, anulaciones y devoluciones (completadas o
   * pendientes). null con reversalAmbiguous: no es determinable.
   */
  reversalAmount: number | null
  /** Facturación ajustada: bruto − reversiones. null si la reversión es ambigua. */
  grossAmount: number | null
  feeAmount: number
  /** Logística absorbida por BEYONIX. */
  shippingCost: number
  /** Otros gastos directos; negativo cuando el canal liquida ingresos extra (ML). */
  otherCosts: number
  /** null si la reversión es ambigua. */
  netAmount: number | null
  costableUnits: number
  costAmount: number | null
  costSource: SaleCostSource
  /**
   * La reversión no se puede atribuir con los datos disponibles (NC sin
   * ítem + devolución física sin NC, con montos distintos según se
   * interprete): reversión, facturación, neto y resultado quedan en null.
   * Nunca se informa una cota como si fuera el dato.
   */
  reversalAmbiguous: boolean
  profitAmount: number | null
  /** Resultado sobre facturación ajustada. */
  marginPercent: number | null
}

function finite(value: unknown) {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

export function buildSaleFinancials(input: {
  grossSales: number
  reversalAmount?: number
  feeAmount?: number
  shippingCost?: number
  otherCosts?: number
  /**
   * Neto informado por el canal (Total liquidado de Mercado Libre). Manda
   * sobre la reconstrucción: la diferencia con bruto − reversiones −
   * comisiones − envío queda en otherCosts para que el desglose concilie.
   */
  reportedNetAmount?: number | null
  costableUnits: number
  costAmount: number | null
  costSource: SaleCostSource
  /** Ganancia declarada que manda sobre neto − costo (ventas externas históricas). */
  declaredProfit?: number | null
  reversalAmbiguous?: boolean
}): SaleFinancials {
  const grossSales = finite(input.grossSales)
  const reversalAmount = finite(input.reversalAmount)
  const grossAmount = grossSales - reversalAmount
  const feeAmount = finite(input.feeAmount)
  const shippingCost = finite(input.shippingCost)
  const reportedNet =
    input.reportedNetAmount != null && Number.isFinite(Number(input.reportedNetAmount))
      ? Number(input.reportedNetAmount)
      : null
  const otherCosts =
    reportedNet == null
      ? finite(input.otherCosts)
      : grossAmount - feeAmount - shippingCost - reportedNet
  const netAmount =
    reportedNet ?? grossAmount - feeAmount - shippingCost - otherCosts
  const costAmount =
    input.costAmount == null || !Number.isFinite(input.costAmount)
      ? null
      : input.costAmount
  const reversalAmbiguous = input.reversalAmbiguous === true
  const profitAmount = reversalAmbiguous
    ? null
    : input.declaredProfit != null
      ? input.declaredProfit
      : costAmount == null
        ? null
        : netAmount - costAmount

  return {
    grossSales,
    reversalAmount: reversalAmbiguous ? null : reversalAmount,
    grossAmount: reversalAmbiguous ? null : grossAmount,
    feeAmount,
    shippingCost,
    otherCosts,
    netAmount: reversalAmbiguous ? null : netAmount,
    costableUnits: Math.max(0, finite(input.costableUnits)),
    costAmount,
    costSource: input.costSource,
    reversalAmbiguous,
    profitAmount,
    marginPercent:
      profitAmount != null && grossAmount > 0
        ? (profitAmount / grossAmount) * 100
        : null,
  }
}

export interface SaleFinancialTotals {
  grossSales: number
  /** null si alguna línea tiene reversión ambigua: el total no es determinable. */
  reversals: number | null
  grossAmount: number | null
  fees: number
  shippingCost: number
  otherCosts: number
  netSales: number | null
  costOfGoodsSold: number
  costableUnits: number
  confirmedCostUnits: number
  inferredCostUnits: number
  missingCostUnits: number
  /** Líneas sin costo determinable (incluye pedidos web sin detalle). */
  linesWithoutCost: number
  /** Líneas cuya reversión no se puede atribuir (ver SaleFinancials.reversalAmbiguous). */
  ambiguousReversalLines: number
  /** Unidades con costo conocido (confirmado o inferido). */
  costCoveragePercent: number
  inferredCostPercent: number
  /** Ventas netas − costo de mercadería; null si alguna línea no tiene costo. */
  contributionResult: number | null
  contributionMarginPercent: number | null
}

export function summarizeSaleFinancials(
  rows: Array<Omit<SaleFinancials, "marginPercent" | "profitAmount">>,
): SaleFinancialTotals {
  const totals = {
    grossSales: 0,
    reversals: 0,
    grossAmount: 0,
    fees: 0,
    shippingCost: 0,
    otherCosts: 0,
    netSales: 0,
    costOfGoodsSold: 0,
    costableUnits: 0,
    confirmedCostUnits: 0,
    inferredCostUnits: 0,
    missingCostUnits: 0,
    linesWithoutCost: 0,
    ambiguousReversalLines: 0,
  }

  for (const row of rows) {
    if (row.reversalAmbiguous) totals.ambiguousReversalLines += 1
    totals.grossSales += row.grossSales
    totals.reversals += row.reversalAmount ?? 0
    totals.grossAmount += row.grossAmount ?? 0
    totals.fees += row.feeAmount
    totals.shippingCost += row.shippingCost
    totals.otherCosts += row.otherCosts
    totals.netSales += row.netAmount ?? 0
    totals.costableUnits += row.costableUnits
    if (row.costAmount == null) {
      totals.linesWithoutCost += 1
      totals.missingCostUnits += row.costableUnits
      continue
    }
    totals.costOfGoodsSold += row.costAmount
    if (row.costSource === "inferred") totals.inferredCostUnits += row.costableUnits
    else totals.confirmedCostUnits += row.costableUnits
  }

  // Una sola línea ambigua vuelve no determinable todo total que la incluya:
  // una venta sana no "rescata" el número.
  const determinable = totals.ambiguousReversalLines === 0
  const grossAmount = determinable ? totals.grossAmount : null
  const netSales = determinable ? totals.netSales : null
  const contributionResult =
    totals.linesWithoutCost === 0 && netSales != null
      ? netSales - totals.costOfGoodsSold
      : null

  return {
    ...totals,
    reversals: determinable ? totals.reversals : null,
    grossAmount,
    netSales,
    costCoveragePercent: getCoveragePercent(
      totals.confirmedCostUnits + totals.inferredCostUnits,
      totals.costableUnits,
    ),
    inferredCostPercent:
      totals.costableUnits > 0
        ? (totals.inferredCostUnits / totals.costableUnits) * 100
        : 0,
    contributionResult,
    contributionMarginPercent:
      contributionResult != null && grossAmount != null && grossAmount > 0
        ? (contributionResult / grossAmount) * 100
        : null,
  }
}

export function getCoveragePercent(coveredUnits: number, costableUnits: number) {
  return costableUnits > 0 ? (coveredUnits / costableUnits) * 100 : 100
}

/** Resultado operativo = resultado comercial − gastos registrados pagados. */
export function calculateOperatingResult(
  contributionResult: number | null,
  paidExpenses: number,
): number | null {
  return contributionResult == null ? null : contributionResult - paidExpenses
}
