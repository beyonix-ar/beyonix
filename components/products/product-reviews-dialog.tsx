"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import {
  ArrowDownWideNarrow,
  Check,
  ChevronDown,
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
  const [sortOpen, setSortOpen] = useState(false)
  const sortMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!sortOpen) return

    const handlePointerDown = (event: MouseEvent) => {
      if (!sortMenuRef.current?.contains(event.target as Node)) {
        setSortOpen(false)
      }
    }

    document.addEventListener("mousedown", handlePointerDown)

    return () => {
      document.removeEventListener("mousedown", handlePointerDown)
    }
  }, [sortOpen])

  useEffect(() => {
    if (!isOpen) setSortOpen(false)
  }, [isOpen])

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
  const selectedSortLabel =
    sortOptions.find((option) => option.value === sort)?.label ??
    sortOptions[0].label

  return (
    <>
      <button
        type="button"
        aria-label={`Ver todas las reseñas de ${productName}`}
        title="Ver reseñas"
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
            title="Cerrar reseñas"
            onClick={() => setIsOpen(false)}
            className="absolute inset-0 cursor-pointer"
          />

          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="product-reviews-dialog-title"
            className="product-reviews-dialog relative z-10 flex max-h-[min(780px,calc(100vh-32px))] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-beyonix-blue-light/28 bg-beyonix-surface text-white shadow-[0_24px_72px_rgba(0,0,0,0.72),0_0_38px_rgba(30,140,255,0.1)]"
          >
            <header className="product-reviews-dialog-header flex shrink-0 items-start justify-between gap-4 border-b border-beyonix-blue-light/16 bg-beyonix-surface px-5 py-5 md:px-6">
              <div className="min-w-0">
                <p className="text-12px font-bold uppercase tracking-widest text-[#8CC8F2]">
                  Opiniones verificadas
                </p>
                <h3
                  id="product-reviews-dialog-title"
                  className="mt-1 text-25px font-black leading-tight text-white"
                >
                  Ver todas las reseñas
                </h3>
                <p className="mt-1 line-clamp-1 text-15px font-semibold text-white/58">
                  {productName}
                </p>
              </div>

              <button
                type="button"
                aria-label="Cerrar reseñas"
                title="Cerrar reseñas"
                onClick={() => setIsOpen(false)}
                className="flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-full border border-beyonix-blue-light/32 bg-[#07121E] text-white/84 transition-all hover:border-beyonix-sky/62 hover:bg-beyonix-blue/45 hover:text-white active:scale-95"
              >
                <X className="size-4" />
              </button>
            </header>

            <div className="product-reviews-dialog-body custom-scrollbar min-h-0 flex-1 overflow-y-auto bg-beyonix-surface px-5 py-5 md:px-6">
              <div className="flex flex-col gap-3 rounded-lg border border-beyonix-blue-500/40 bg-beyonix-surface-2 p-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 items-center gap-3">
                  <p className="shrink-0 text-25px font-black leading-none text-white">
                    {safeAverageLabel}
                    <span className="ml-1 text-15px font-semibold text-beyonix-gray-500">
                      / 5
                    </span>
                  </p>
                  <span
                    className="h-8 w-px shrink-0 bg-beyonix-gray-700"
                    aria-hidden="true"
                  />
                  <div className="min-w-0">
                    <ProductRatingSummary
                      averageRating={average}
                      reviewsCount={visibleReviewsCount}
                      className="text-13px"
                      starClassName="size-3.5"
                      countClassName="text-beyonix-gray-500"
                    />
                    <p className="mt-1 text-11px font-medium text-beyonix-gray-300">
                      {visibleReviewsCount}{" "}
                      {visibleReviewsCount === 1
                        ? "reseña verificada"
                        : "reseñas verificadas"}
                    </p>
                  </div>
                </div>

                <div className="flex min-w-0 items-center gap-2 sm:shrink-0">
                  <span className="inline-flex shrink-0 items-center gap-1.5 text-11px font-medium uppercase tracking-widest text-beyonix-sky">
                    <ArrowDownWideNarrow className="size-3" />
                    Ordenar por
                  </span>
                  <div
                    ref={sortMenuRef}
                    onKeyDown={(event) => {
                      if (event.key !== "Escape" || !sortOpen) return
                      event.stopPropagation()
                      setSortOpen(false)
                    }}
                    className="relative min-w-0 flex-1 sm:w-44 sm:flex-none"
                  >
                    <button
                      type="button"
                      aria-label="Ordenar reseñas"
                      aria-haspopup="listbox"
                      aria-expanded={sortOpen}
                      title="Ordenar reseñas"
                      onClick={() => setSortOpen((current) => !current)}
                      className="flex h-8 w-full cursor-pointer items-center justify-between gap-3 rounded-lg border border-beyonix-blue-500/50 bg-beyonix-blue-900 px-2.5 text-left text-11px font-medium text-white outline-none transition-colors hover:border-beyonix-blue-300 hover:bg-beyonix-blue-700 focus-visible:border-beyonix-blue-300"
                    >
                      <span className="truncate">{selectedSortLabel}</span>
                      <ChevronDown
                        className={cn(
                          "size-3 shrink-0 text-white transition-transform",
                          sortOpen && "rotate-180",
                        )}
                        aria-hidden="true"
                      />
                    </button>

                    {sortOpen && (
                      <div
                        role="listbox"
                        aria-label="Opciones de orden"
                        className="absolute right-0 top-full z-20 mt-1 w-full min-w-44 overflow-hidden rounded-lg border border-beyonix-blue-500/50 bg-beyonix-surface p-1"
                      >
                        {sortOptions.map((option) => {
                          const active = option.value === sort

                          return (
                            <button
                              key={option.value}
                              type="button"
                              role="option"
                              aria-selected={active}
                              aria-label={`Ordenar por ${option.label}`}
                              title={option.label}
                              onClick={() => {
                                setSort(option.value)
                                setSortOpen(false)
                              }}
                              className={cn(
                                "flex h-7 w-full cursor-pointer items-center justify-between gap-3 rounded-md px-2.5 text-left text-8px font-normal transition-colors",
                                active
                                  ? "bg-beyonix-blue-500 text-white"
                                  : "text-beyonix-gray-300 hover:bg-beyonix-blue-700 hover:text-white",
                              )}
                            >
                              <span>{option.label}</span>
                              {active && (
                                <Check
                                  className="size-3 shrink-0 text-white"
                                  aria-hidden="true"
                                />
                              )}
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {loading ? (
                <div className="flex min-h-52 items-center justify-center gap-2 text-15px font-semibold text-beyonix-sky/75">
                  <LoaderCircle className="size-5 animate-spin" />
                  Cargando reseñas...
                </div>
              ) : errorMessage ? (
                <p
                  role="alert"
                  className="mt-5 rounded-xl border border-red-300/24 bg-red-500/10 px-4 py-3 text-15px font-semibold text-red-100"
                >
                  {errorMessage}
                </p>
              ) : visibleReviews.length === 0 ? (
                <div className="mt-5 rounded-xl border border-beyonix-blue-light/18 bg-[#0D1720] px-4 py-8 text-center">
                  <MessageSquareText className="mx-auto size-6 text-beyonix-sky" />
                  <p className="mt-3 text-15px font-bold text-white">
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
                            <span className="text-12px font-bold uppercase tracking-widest text-white/36">
                              {dateLabel}
                            </span>
                          )}
                        </div>

                        {review.comment.trim() ? (
                          <p className="mt-3 text-15px leading-6 text-white/84">
                            "{review.comment}"
                          </p>
                        ) : (
                          <p className="mt-3 text-15px font-semibold text-white/55">
                            Calificación verificada
                          </p>
                        )}

                        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-white/8 pt-3 text-13px font-semibold text-white/58">
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
