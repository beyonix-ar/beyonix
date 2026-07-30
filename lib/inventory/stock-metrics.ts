export interface ReturnStockQuantities {
  received: number
  sellable: number
  discounted: number
  nonSellable: number
  pendingReview: number
}

export interface InventoryStockMetrics {
  normal: number
  discounted: number
  nonSellable: number
  pendingReview: number
  sellable: number
  quarantine: number
  physical: number
}

function finiteInteger(value: unknown, allowNegative = false) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 0

  const integer = Math.trunc(parsed)
  return allowNegative ? integer : Math.max(0, integer)
}

export function classifyReturnStock(input: {
  received?: unknown
  sellable?: unknown
  discounted?: unknown
  nonSellable?: unknown
}): ReturnStockQuantities {
  const received = finiteInteger(input.received)
  const sellable = finiteInteger(input.sellable)
  const discounted = finiteInteger(input.discounted)
  const nonSellable = finiteInteger(input.nonSellable)
  const classified = sellable + discounted + nonSellable

  return {
    received,
    sellable,
    discounted,
    nonSellable,
    pendingReview: Math.max(0, received - classified),
  }
}

export function calculateInventoryStock(input: {
  normal?: unknown
  discounted?: unknown
  nonSellable?: unknown
  pendingReview?: unknown
}): InventoryStockMetrics {
  // El stock normal puede ser negativo: ocultarlo impediría detectar una
  // sobreventa o una inconsistencia del libro de movimientos.
  const normal = finiteInteger(input.normal, true)
  const discounted = finiteInteger(input.discounted)
  const nonSellable = finiteInteger(input.nonSellable)
  const pendingReview = finiteInteger(input.pendingReview)
  const sellable = normal + discounted
  const quarantine = nonSellable + pendingReview

  return {
    normal,
    discounted,
    nonSellable,
    pendingReview,
    sellable,
    quarantine,
    physical: sellable + quarantine,
  }
}
