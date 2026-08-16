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
