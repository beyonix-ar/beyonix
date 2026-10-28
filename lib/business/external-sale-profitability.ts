function finiteNumber(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function finiteNonNegativeNumber(value: unknown) {
  if (value == null || value === "") return null
  const number = finiteNumber(value)
  return number != null && number >= 0 ? number : null
}

/**
 * Costo unitario de una venta externa. Con producto vinculado sólo vale el
 * costo histórico a la fecha de la venta (nunca el de hoy). Sin producto
 * vinculado sólo un costo cargado a mano; $0 es el valor por defecto de la
 * columna y significa "no informado", no "costo cero".
 */
export function resolveExternalSaleUnitCost({
  productId,
  historicalUnitCost,
  manualUnitCost,
}: {
  productId: number | null
  historicalUnitCost: number | null
  manualUnitCost: unknown
}) {
  if (productId != null) {
    return finiteNonNegativeNumber(historicalUnitCost)
  }

  const manual = finiteNonNegativeNumber(manualUnitCost)
  return manual != null && manual > 0 ? manual : null
}

export function getExternalSaleMerchandiseCost(
  unitCost: number | null,
  quantity: unknown,
) {
  const safeUnitCost = finiteNonNegativeNumber(unitCost)
  const safeQuantity = finiteNonNegativeNumber(quantity)
  if (safeUnitCost == null || safeQuantity == null) return null
  return safeUnitCost * safeQuantity
}

export function calculateExternalSaleProfitability({
  grossAmount,
  feeAmount,
  shippingAmount,
  otherExpenseAmount,
  merchandiseCost,
}: {
  grossAmount: unknown
  feeAmount: unknown
  shippingAmount: unknown
  otherExpenseAmount: unknown
  merchandiseCost: number | null
}) {
  const gross = finiteNumber(grossAmount)
  const fee = finiteNumber(feeAmount)
  const shipping = finiteNumber(shippingAmount)
  const otherExpense = finiteNumber(otherExpenseAmount)
  const cost = finiteNonNegativeNumber(merchandiseCost)

  if (gross == null || fee == null || shipping == null || otherExpense == null) {
    return {
      revenueAfterFees: null,
      profitAmount: null,
      marginPercent: null,
    }
  }

  const revenueAfterFees = gross - fee - shipping - otherExpense
  const profitAmount = cost == null ? null : revenueAfterFees - cost

  return {
    revenueAfterFees,
    profitAmount,
    marginPercent:
      profitAmount != null && gross > 0
        ? (profitAmount / gross) * 100
        : null,
  }
}

/**
 * known: costo de mercadería conocido (calculado o implícito).
 * undeterminable: no hay costo histórico ni ganancia declarada.
 * inconsistent: la ganancia declarada supera el ingreso neto; el costo
 * implícito sería negativo y no se inventa.
 */
export type ExternalSaleCostStatus = "known" | "undeterminable" | "inconsistent"

/**
 * Ganancia que reportan Dashboard y Ventas externas. Una venta histórica
 * (stock_effect = none) conserva la ganancia declarada en el Excel: nunca se
 * reemplaza por una calculada con costos posteriores. Una venta nueva usa el
 * costo de mercadería y sólo cae en la declarada si ese costo no se conoce.
 * Con ganancia declarada, el costo implícito (ingreso neto - ganancia)
 * mantiene el costo de ventas coherente con la ganancia informada. Si la
 * ganancia declarada supera el ingreso neto, se conserva la ganancia, el
 * costo queda "no determinable" (null) y la fila se marca inconsistente: no
 * suma al costo de ventas ni a la cobertura de costos, y quien reporta debe
 * avisarlo en vez de ocultarlo.
 */
export function resolveExternalSaleReportedProfitability({
  stockEffect,
  declaredProfit,
  merchandiseCost,
  ...amounts
}: Parameters<typeof calculateExternalSaleProfitability>[0] & {
  stockEffect: unknown
  declaredProfit: unknown
}) {
  const computed = calculateExternalSaleProfitability({ ...amounts, merchandiseCost })
  const declared = declaredProfit == null || declaredProfit === "" ? null : finiteNumber(declaredProfit)
  const useDeclared =
    declared != null &&
    computed.revenueAfterFees != null &&
    (stockEffect === "none" || computed.profitAmount == null)

  if (!useDeclared || computed.revenueAfterFees == null || declared == null) {
    const known = computed.profitAmount != null
    return {
      ...computed,
      merchandiseCost: known ? finiteNonNegativeNumber(merchandiseCost) : null,
      profitSource: known ? ("calculated" as const) : null,
      costStatus: (known ? "known" : "undeterminable") as ExternalSaleCostStatus,
    }
  }

  const gross = finiteNumber(amounts.grossAmount) ?? 0
  const impliedCost = Math.round((computed.revenueAfterFees - declared) * 100) / 100
  return {
    revenueAfterFees: computed.revenueAfterFees,
    profitAmount: declared,
    marginPercent: gross > 0 ? (declared / gross) * 100 : null,
    merchandiseCost: impliedCost >= 0 ? impliedCost : null,
    profitSource: "declared" as const,
    costStatus: (impliedCost >= 0 ? "known" : "inconsistent") as ExternalSaleCostStatus,
  }
}
