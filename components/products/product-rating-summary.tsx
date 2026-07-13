import { Star } from "lucide-react"

import { cn } from "@/lib/utils"

interface ProductRatingSummaryProps {
  averageRating?: number | null
  reviewsCount?: number | null
  className?: string
  starClassName?: string
  countClassName?: string
}

function getVisibleRating(averageRating?: number | null) {
  const rating = Number(averageRating)

  if (!Number.isFinite(rating)) return 0

  return Math.max(0, Math.min(5, Math.round(rating)))
}

export function ProductRatingSummary({
  averageRating,
  reviewsCount,
  className,
  starClassName,
  countClassName,
}: ProductRatingSummaryProps) {
  const safeReviewsCount = Number(reviewsCount)

  if (!Number.isInteger(safeReviewsCount) || safeReviewsCount <= 0) {
    return null
  }

  const visibleRating = getVisibleRating(averageRating)
  const safeAverage = Number(averageRating)
  const averageLabel = Number.isFinite(safeAverage)
    ? safeAverage.toFixed(1).replace(".0", "")
    : String(visibleRating)

  return (
    <div
      className={cn("flex shrink-0 items-center gap-1 text-yellow-400", className)}
      aria-label={`${averageLabel} de 5 estrellas basado en ${safeReviewsCount} ${
        safeReviewsCount === 1 ? "reseña" : "reseñas"
      }`}
    >
      {[1, 2, 3, 4, 5].map((rating) => (
        <Star
          key={rating}
          className={cn(
            "fill-current",
            rating <= visibleRating ? "text-yellow-400" : "fill-transparent text-white/24",
            starClassName,
          )}
        />
      ))}
      <span className={cn("ml-0.5", countClassName)}>({safeReviewsCount})</span>
    </div>
  )
}
