import { supabase } from "@/lib/supabase/client"
import type { SupabaseProducto } from "@/lib/supabase/types"

export interface ProductReviewSummary {
  average_rating: number | null
  reviews_count: number
}

interface ReviewSummaryAccumulator {
  total: number
  count: number
}

interface ProductReviewSummaryRow {
  product_id: number | null
  rating: number | null
}

const EMPTY_REVIEW_SUMMARY: ProductReviewSummary = {
  average_rating: null,
  reviews_count: 0,
}

export function summarizeProductReviewRows(rows: ProductReviewSummaryRow[]) {
  const totals = new Map<number, ReviewSummaryAccumulator>()

  for (const review of rows) {
    const productId = Number(review.product_id)
    const rating = Number(review.rating)

    if (
      !Number.isInteger(productId) ||
      productId <= 0 ||
      !Number.isFinite(rating) ||
      rating < 1 ||
      rating > 5
    ) {
      continue
    }

    const current = totals.get(productId) ?? { total: 0, count: 0 }
    current.total += rating
    current.count += 1
    totals.set(productId, current)
  }

  return new Map(
    [...totals.entries()].map(([productId, summary]) => [
      productId,
      {
        average_rating: summary.total / summary.count,
        reviews_count: summary.count,
      },
    ]),
  )
}

export async function getProductReviewSummaryMap(productIds: number[]) {
  const uniqueProductIds = [...new Set(productIds)]
    .filter((id) => Number.isInteger(id) && id > 0)

  if (uniqueProductIds.length === 0) {
    return new Map<number, ProductReviewSummary>()
  }

  const { data, error } = await supabase
    .from("reviews")
    .select("product_id, rating")
    .in("product_id", uniqueProductIds)
    .eq("approved", true)

  if (error) {
    throw error
  }

  return summarizeProductReviewRows(data ?? [])
}

export async function attachProductReviewSummaries<T extends SupabaseProducto>(
  products: T[],
) {
  const summaries = await getProductReviewSummaryMap(
    products.map((product) => product.id),
  )

  return products.map((product) => ({
    ...product,
    ...(summaries.get(product.id) ?? EMPTY_REVIEW_SUMMARY),
  }))
}
