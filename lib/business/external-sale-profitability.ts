function finiteNumber(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function finiteNonNegativeNumber(value: unknown) {
  if (value == null || value === "") return null
  const number = finiteNumber(value)
  return number != null && number >= 0 ? number : null
}

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

  return finiteNonNegativeNumber(manualUnitCost)
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
 * Ganancia que reportan Dashboard y Ventas externas. Una venta histórica
 * (stock_effect = none) conserva la ganancia declarada en el Excel: nunca se
 * reemplaza por una calculada con costos posteriores. Una venta nueva usa el
 * costo de mercadería y sólo cae en la declarada si ese costo no se conoce.
 * Con ganancia declarada, el costo implícito (ingreso neto - ganancia)
 * mantiene el costo de ventas coherente con la ganancia informada.
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
    return {
      ...computed,
      merchandiseCost: computed.profitAmount == null ? null : finiteNonNegativeNumber(merchandiseCost),
      profitSource: computed.profitAmount == null ? null : ("calculated" as const),
    }
  }

  const gross = finiteNumber(amounts.grossAmount) ?? 0
  const impliedCost = computed.revenueAfterFees - declared
  return {
    revenueAfterFees: computed.revenueAfterFees,
    profitAmount: declared,
    marginPercent: gross > 0 ? (declared / gross) * 100 : null,
    merchandiseCost: impliedCost >= 0 ? impliedCost : null,
    profitSource: "declared" as const,
  }
}
