"use client"

import { useEffect, useState } from "react"
import { Star } from "lucide-react"

import { ProductRatingSummary } from "./product-rating-summary"

type ProductReview = {
  id: number
  rating: number
  comment: string
  nickname: string
  city: string
  province: string
  createdAt: string
}

export function ProductReviews({ productId }: { productId: number }) {
  const [reviews, setReviews] = useState<ProductReview[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true

    fetch(`/api/reviews?productId=${productId}`, { cache: "no-store" })
      .then(async (response) => {
        const data = (await response.json()) as { reviews?: ProductReview[] }

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
    <section className="mx-auto w-full max-w-7xl border-t border-white/8 px-4 py-8 lg:px-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-black uppercase tracking-widest text-blue-300">
            Opiniones verificadas
          </p>
          <h2 className="mt-1 text-xl font-black text-white">
            Reseñas del producto
          </h2>
        </div>

        <div className="flex flex-col items-end gap-1 text-right">
          <p className="text-2xl font-black text-white">
            {average.toFixed(1).replace(".0", "")} / 5
          </p>
          <ProductRatingSummary
            averageRating={average}
            reviewsCount={reviews.length}
            className="text-xs"
            starClassName="size-4"
            countClassName="text-white/55"
          />
        </div>
      </div>

      <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {reviews.map((review) => (
          <article
            key={review.id}
            className="rounded-xl border border-white/8 bg-[#141414] p-4"
          >
            <div
              className="flex gap-1"
              aria-label={`${review.rating} de 5 estrellas`}
            >
              {[1, 2, 3, 4, 5].map((rating) => (
                <Star
                  key={rating}
                  className={`size-4 ${
                    rating <= review.rating
                      ? "fill-amber-300 text-amber-300"
                      : "text-white/20"
                  }`}
                />
              ))}
            </div>

            <p className="mt-3 text-sm leading-6 text-white/85">
              "{review.comment}"
            </p>
            <p className="mt-3 text-xs font-black text-white">
              {review.nickname}
            </p>
            <p className="mt-0.5 text-[11px] text-white/45">
              {review.city} · {review.province}
            </p>
          </article>
        ))}
      </div>
    </section>
  )
}
