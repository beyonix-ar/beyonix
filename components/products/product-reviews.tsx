"use client"

import { useEffect, useState } from "react"
import { Star } from "lucide-react"

type ProductReview = {
  id: number
  rating: number
  comment: string
  nickname: string
  city: string
  province: string
  createdAt: string
}

const MIN_PUBLIC_REVIEWS = 10

export function ProductReviews({ productId }: { productId: number }) {
  const [reviews, setReviews] = useState<ProductReview[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    fetch(`/api/reviews?productId=${productId}`, { cache: "no-store" })
      .then(async (response) => {
        const data = (await response.json()) as { reviews?: ProductReview[] }
        if (active && response.ok) setReviews(data.reviews ?? [])
      })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [productId])

  if (loading) return null

  if (reviews.length < MIN_PUBLIC_REVIEWS) {
    return (
      <section className="mx-auto w-full max-w-7xl border-t border-white/8 px-4 py-8 lg:px-8">
        <h2 className="text-xl font-black text-white">Opiniones sobre este producto</h2>
        <p className="mt-2 text-sm text-white/55">Este producto aún no tiene suficientes reseñas para publicar una valoración representativa.</p>
      </section>
    )
  }

  const average = reviews.reduce((total, review) => total + review.rating, 0) / reviews.length

  return (
    <section className="mx-auto w-full max-w-7xl border-t border-white/8 px-4 py-8 lg:px-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><p className="text-xs font-black uppercase tracking-widest text-blue-300">Opiniones verificadas</p><h2 className="mt-1 text-xl font-black text-white">Reseñas del producto</h2></div>
        <div className="text-right"><p className="text-2xl font-black text-white">{average.toFixed(1)} / 5</p><p className="text-xs text-white/55">{reviews.length} reseñas aprobadas</p></div>
      </div>
      <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {reviews.map((review) => (
          <article key={review.id} className="rounded-xl border border-white/8 bg-[#141414] p-4">
            <div className="flex gap-1" aria-label={`${review.rating} de 5 estrellas`}>{[1, 2, 3, 4, 5].map((rating) => <Star key={rating} className={`size-4 ${rating <= review.rating ? "fill-amber-300 text-amber-300" : "text-white/20"}`} />)}</div>
            <p className="mt-3 text-sm leading-6 text-white/85">“{review.comment}”</p>
            <p className="mt-3 text-xs font-black text-white">{review.nickname}</p>
            <p className="mt-0.5 text-[11px] text-white/45">{review.city} · {review.province}</p>
          </article>
        ))}
      </div>
    </section>
  )
}
