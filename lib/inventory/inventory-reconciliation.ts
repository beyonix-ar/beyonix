export interface VariantAllocationState {
  genericBalance: number
  allocationQuantity: number
  variantMovementBalance: number
  storedVariantStock: number
  historicalLinkedReturnQuantity: number
}

export interface VariantAllocationDiagnosis {
  calculatedStock: number
  duplicatedAllocation: number
  expectedStock: number
  difference: number
}

function units(value: number) {
  return Number.isFinite(value) ? Math.max(Math.trunc(value), 0) : 0
}

export function diagnoseVariantAllocation(
  state: VariantAllocationState,
): VariantAllocationDiagnosis {
  const genericBalance = units(state.genericBalance)
  const allocationQuantity = units(state.allocationQuantity)
  const variantMovementBalance = Math.trunc(state.variantMovementBalance)
  const storedVariantStock = Math.trunc(state.storedVariantStock)
  const historicalReturn = units(state.historicalLinkedReturnQuantity)
  const allocationOverflow = Math.max(allocationQuantity - genericBalance, 0)
  const duplicatedAllocation = Math.min(
    allocationQuantity,
    historicalReturn,
    allocationOverflow,
  )
  const calculatedStock = allocationQuantity + variantMovementBalance
  const expectedStock = calculatedStock - duplicatedAllocation

  return {
    calculatedStock,
    duplicatedAllocation,
    expectedStock,
    difference: storedVariantStock - expectedStock,
  }
}

export function repairVariantAllocation(
  state: VariantAllocationState,
  confirmed: boolean,
) {
  const diagnosis = diagnoseVariantAllocation(state)
  if (!confirmed) throw new Error("REPAIR_CONFIRMATION_REQUIRED")
  if (diagnosis.duplicatedAllocation <= 0) {
    throw new Error("NO_PROVEN_DUPLICATE_MOVEMENT")
  }

  return {
    allocationQuantity:
      units(state.allocationQuantity) - diagnosis.duplicatedAllocation,
    physicalDelta: 0,
    repairedQuantity: diagnosis.duplicatedAllocation,
  }
}
