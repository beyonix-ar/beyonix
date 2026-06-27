import type {
  SupabaseProducto,
} from "@/lib/supabase/types"

export interface ProductPriceRange {
  min: number
  max: number
  step: number
}

export function getProductPriceRange(
  products: SupabaseProducto[]
): ProductPriceRange {
  const prices = products
    .map((product) => Number(product.precio))
    .filter(
      (price) =>
        Number.isFinite(price) &&
        price >= 0
    )

  if (!prices.length) {
    return {
      min: 0,
      max: 1000,
      step: 1,
    }
  }

  const highestPrice = Math.max(...prices)
  const lowestPrice = Math.min(...prices)
  const step =
    highestPrice <= 1000
      ? 1
      : highestPrice <= 10000
        ? 100
        : 1000
  const min =
    Math.floor(lowestPrice / step) *
    step
  let max =
    Math.ceil(highestPrice / step) *
    step

  if (max <= min) {
    max = min + step
  }

  return {
    min,
    max,
    step,
  }
}
