"use client"

import { useEffect, useMemo, useState } from "react"
import {
  ArrowDownWideNarrow,
  LoaderCircle,
  MapPin,
  MessageSquareText,
  Star,
  UserRound,
  X,
} from "lucide-react"

import { cn } from "@/lib/utils"

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

type ReviewSort = "relevant" | "recent" | "highest"

interface ProductReviewsDialogProps {
  productId: number
  productName: string
  averageRating?: number | null
  reviewsCount: number
}

const sortOptions: Array<{
  value: ReviewSort
  label: string
}> = [
  {
    value: "relevant",
    label: "Más relevantes",
  },
  {
    value: "recent",
    label: "Más recientes",
  },
  {
    value: "highest",
    label: "Mejor puntuadas",
  },
]

function getReviewDateValue(review: ProductReview) {
  const date = new Date(review.createdAt).getTime()

  return Number.isFinite(date) ? date : 0
}

function formatReviewDate(value: string) {
  const date = new Date(value)

  if (Number.isNaN(date.getTime())) return null

  return new Intl.DateTimeFormat("es-AR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date)
}

function getSortedReviews(reviews: ProductReview[], sort: ReviewSort) {
  return [...reviews].sort((first, second) => {
    const firstDate = getReviewDateValue(first)
    const secondDate = getReviewDateValue(second)

    if (sort === "recent") {
      return secondDate - firstDate
    }

    if (sort === "highest") {
      if (second.rating !== first.rating) return second.rating - first.rating

      return secondDate - firstDate
    }

    const firstHasComment = first.comment.trim().length > 0 ? 1 : 0
    const secondHasComment = second.comment.trim().length > 0 ? 1 : 0

    if (secondHasComment !== firstHasComment) {
      return secondHasComment - firstHasComment
    }

    if (second.rating !== first.rating) return second.rating - first.rating

    return secondDate - firstDate
  })
}

export function ProductReviewsDialog({
  productId,
  productName,
  averageRating,
  reviewsCount,
}: ProductReviewsDialogProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [reviews, setReviews] = useState<ProductReview[]>([])
  const [loading, setLoading] = useState(false)
  const [errorMessage, setErrorMessage] = useState("")
  const [sort, setSort] = useState<ReviewSort>("relevant")

  useEffect(() => {
    if (!isOpen) return

    const previousBodyOverflow = document.body.style.overflow
    const previousHtmlOverflow = document.documentElement.style.overflow

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsOpen(false)
      }
    }

    document.body.style.overflow = "hidden"
    document.documentElement.style.overflow = "hidden"
    window.addEventListener("keydown", handleKeyDown)

    return () => {
      document.body.style.overflow = previousBodyOverflow
      document.documentElement.style.overflow = previousHtmlOverflow
      window.removeEventListener("keydown", handleKeyDown)
    }
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return

    let active = true

    setLoading(true)
    setErrorMessage("")

    fetch(`/api/reviews?productId=${productId}`, { cache: "no-store" })
      .then(async (response) => {
        const data = (await response.json()) as {
          reviews?: ProductReview[]
          error?: string
        }

        if (!active) return

        if (!response.ok) {
          throw new Error(data.error || "No pudimos cargar las reseñas.")
        }

        setReviews(data.reviews ?? [])
      })
      .catch((error) => {
        if (!active) return

        setErrorMessage(
          error instanceof Error
            ? error.message
            : "No pudimos cargar las reseñas."
        )
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => {
      active = false
    }
  }, [isOpen, productId])

  const visibleReviews = useMemo(
    () => getSortedReviews(reviews, sort),
    [reviews, sort]
  )
  const visibleReviewsCount = reviews.length || reviewsCount
  const average =
    reviews.length > 0
      ? reviews.reduce((total, review) => total + review.rating, 0) /
        reviews.length
      : averageRating
  const averageLabel = Number(average)
  const safeAverageLabel = Number.isFinite(averageLabel)
    ? averageLabel.toFixed(1).replace(".0", "")
    : "0"

  return (
    <>
      <button
        type="button"
        aria-label={`Ver todas las reseñas de ${productName}`}
        onClick={() => setIsOpen(true)}
        className="inline-flex h-8 shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-full border border-beyonix-blue-light/26 bg-white/[0.03] px-3 text-12px font-bold text-beyonix-sky/90 transition-all duration-200 hover:border-beyonix-sky/58 hover:bg-beyonix-blue/24 hover:text-white active:scale-95"
      >
        <MessageSquareText className="size-3.5" />
        Ver reseñas
      </button>

      {isOpen && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-[#02070B]/90 p-4 backdrop-blur-md">
          <button
            type="button"
            aria-label="Cerrar reseñas"
            onClick={() => setIsOpen(false)}
            className="absolute inset-0 cursor-pointer"
          />

          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="product-reviews-dialog-title"
            className="relative z-10 flex max-h-[min(780px,calc(100vh-32px))] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-beyonix-blue-light/28 bg-[#080B0F] text-white shadow-[0_24px_72px_rgba(0,0,0,0.72),0_0_38px_rgba(30,140,255,0.1)]"
          >
            <header className="flex shrink-0 items-start justify-between gap-4 border-b border-beyonix-blue-light/16 px-5 py-5 md:px-6">
              <div className="min-w-0">
                <p className="text-11px font-bold uppercase tracking-widest text-[#8CC8F2]">
                  Opiniones verificadas
                </p>
                <h3
                  id="product-reviews-dialog-title"
                  className="mt-1 text-2xl font-black leading-tight text-white"
                >
                  Ver todas las reseñas
                </h3>
                <p className="mt-1 line-clamp-1 text-sm font-semibold text-white/58">
                  {productName}
                </p>
              </div>

              <button
                type="button"
                aria-label="Cerrar reseñas"
                onClick={() => setIsOpen(false)}
                className="flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-full border border-beyonix-blue-light/32 bg-[#07121E] text-white/84 transition-all hover:border-beyonix-sky/62 hover:bg-beyonix-blue/45 hover:text-white active:scale-95"
              >
                <X className="size-4" />
              </button>
            </header>

            <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto px-5 py-5 md:px-6">
              <div className="grid gap-4 md:grid-cols-[220px_minmax(0,1fr)]">
                <div className="rounded-xl border border-beyonix-blue-light/18 bg-[#0D1720] p-4">
                  <p className="text-4xl font-black leading-none text-white">
                    {safeAverageLabel}
                    <span className="text-xl text-white/48"> / 5</span>
                  </p>

                  <ProductRatingSummary
                    averageRating={average}
                    reviewsCount={visibleReviewsCount}
                    className="mt-3 text-sm"
                    starClassName="size-4"
                    countClassName="text-white/55"
                  />

                  <p className="mt-3 text-sm font-semibold text-white/58">
                    {visibleReviewsCount}{" "}
                    {visibleReviewsCount === 1
                      ? "reseña verificada"
                      : "reseñas verificadas"}
                  </p>
                </div>

                <div className="flex min-w-0 flex-col justify-between rounded-xl border border-beyonix-blue-light/14 bg-white/[0.02] p-4">
                  <div className="mb-3 flex items-center gap-2 text-12px font-bold uppercase tracking-widest text-[#8CC8F2]">
                    <ArrowDownWideNarrow className="size-4" />
                    Ordenar por
                  </div>

                  <div className="grid gap-2 sm:grid-cols-3">
                    {sortOptions.map((option) => {
                      const active = sort === option.value

                      return (
                        <button
                          key={option.value}
                          type="button"
                          aria-pressed={active}
                          onClick={() => setSort(option.value)}
                          className={cn(
                            "h-10 cursor-pointer rounded-lg border px-3 text-12px font-bold transition-all duration-200 active:scale-[0.98]",
                            active
                              ? "border-beyonix-sky/62 bg-beyonix-blue/42 text-white shadow-[0_0_18px_rgba(30,140,255,0.12)]"
                              : "border-beyonix-blue-light/18 bg-[#07121E] text-white/68 hover:border-beyonix-blue-light/45 hover:text-white"
                          )}
                        >
                          {option.label}
                        </button>
                      )
                    })}
                  </div>
                </div>
              </div>

              {loading ? (
                <div className="flex min-h-52 items-center justify-center gap-2 text-sm font-semibold text-beyonix-sky/75">
                  <LoaderCircle className="size-5 animate-spin" />
                  Cargando reseñas...
                </div>
              ) : errorMessage ? (
                <p
                  role="alert"
                  className="mt-5 rounded-xl border border-red-300/24 bg-red-500/10 px-4 py-3 text-sm font-semibold text-red-100"
                >
                  {errorMessage}
                </p>
              ) : visibleReviews.length === 0 ? (
                <div className="mt-5 rounded-xl border border-beyonix-blue-light/18 bg-[#0D1720] px-4 py-8 text-center">
                  <MessageSquareText className="mx-auto size-6 text-beyonix-sky" />
                  <p className="mt-3 text-sm font-bold text-white">
                    Todavía no hay reseñas para este producto
                  </p>
                </div>
              ) : (
                <div className="mt-5 grid gap-3">
                  {visibleReviews.map((review) => {
                    const dateLabel = formatReviewDate(review.createdAt)

                    return (
                      <article
                        key={review.id}
                        className="rounded-xl border border-white/8 bg-[#12171D] p-4"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div
                            className="flex gap-1"
                            aria-label={`${review.rating} de 5 estrellas`}
                          >
                            {[1, 2, 3, 4, 5].map((rating) => (
                              <Star
                                key={rating}
                                className={cn(
                                  "size-4",
                                  rating <= review.rating
                                    ? "fill-amber-300 text-amber-300"
                                    : "text-white/20"
                                )}
                              />
                            ))}
                          </div>

                          {dateLabel && (
                            <span className="text-11px font-bold uppercase tracking-widest text-white/36">
                              {dateLabel}
                            </span>
                          )}
                        </div>

                        {review.comment.trim() ? (
                          <p className="mt-3 text-sm leading-6 text-white/84">
                            "{review.comment}"
                          </p>
                        ) : (
                          <p className="mt-3 text-sm font-semibold text-white/55">
                            Calificación verificada
                          </p>
                        )}

                        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-white/8 pt-3 text-xs font-semibold text-white/58">
                          <span className="inline-flex items-center gap-2 text-white/82">
                            <UserRound className="size-3.5 text-beyonix-sky" />
                            {review.nickname}
                          </span>
                          <span className="inline-flex items-center gap-2">
                            <MapPin className="size-3.5 text-beyonix-cyan" />
                            {review.city} · {review.province}
                          </span>
                        </div>
                      </article>
                    )
                  })}
                </div>
              )}
            </div>
          </section>
        </div>
      )}
    </>
  )
}
