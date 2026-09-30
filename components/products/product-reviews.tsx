"use client"

import { useEffect, useState } from "react"

import {
  PublicReviewCard,
  ReviewStars,
  type PublicReviewView,
} from "@/components/reviews/public-review-card"

function formatAverage(value: number) {
  return new Intl.NumberFormat("es-AR", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  }).format(value)
}

export function ProductReviews({ productId }: { productId: number }) {
  const [reviews, setReviews] = useState<PublicReviewView[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true

    fetch(`/api/reviews?productId=${productId}`, { cache: "no-store" })
      .then(async (response) => {
        const data = (await response.json()) as { reviews?: PublicReviewView[] }

        if (active && response.ok) {
          setReviews(data.reviews ?? [])
        }
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => {
      active = false
    }
  }, [productId])

  if (loading || reviews.length === 0) return null

  const average =
    reviews.reduce((total, review) => total + review.rating, 0) /
    reviews.length

  return (
    <section className="mx-auto w-full max-w-7xl border-t border-[var(--account-border-subtle)] px-4 py-8 lg:px-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-black uppercase tracking-widest text-[var(--account-accent-soft)]">
            Opiniones verificadas
          </p>
          <h2 className="mt-1 text-xl font-black text-[var(--account-text-primary)]">
            Reseñas del producto
          </h2>
        </div>

        <div className="flex flex-col items-end gap-1 text-right">
          <p className="leading-none">
            <span className="text-2xl font-black text-[var(--account-accent-soft)]">
              {formatAverage(average)}
            </span>
            <span className="ml-1 text-sm font-bold text-[var(--account-text-secondary)]">/ 5</span>
          </p>
          <div className="flex items-center gap-1.5">
            <ReviewStars rating={average} />
            <span className="text-xs font-medium text-[var(--account-text-secondary)]">
              ({reviews.length})
            </span>
          </div>
        </div>
      </div>

      <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {reviews.map((review) => (
          <PublicReviewCard key={review.id} review={review} />
        ))}
      </div>
    </section>
  )
}
