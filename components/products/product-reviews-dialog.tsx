"use client"

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react"
import {
  ArrowDownWideNarrow,
  Check,
  ChevronDown,
  LoaderCircle,
  MessageSquareText,
  X,
} from "lucide-react"

import {
  PublicReviewCard,
  ReviewStars,
  type PublicReviewView,
} from "@/components/reviews/public-review-card"
import { cn } from "@/lib/utils"

type ProductReview = PublicReviewView

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

/** "5" / "4,5" / "3,2" -- coma decimal es-AR, sin ",0" innecesario. */
function formatAverage(value: number) {
  return new Intl.NumberFormat("es-AR", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  }).format(value)
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
  const sortTriggerRef = useRef<HTMLButtonElement>(null)
  const sortListRef = useRef<HTMLDivElement>(null)

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

  // Al abrir el desplegable, el foco va a la opción elegida (teclado).
  useEffect(() => {
    if (!sortOpen) return
    sortListRef.current
      ?.querySelector<HTMLButtonElement>('[role="option"][aria-selected="true"]')
      ?.focus()
  }, [sortOpen])

  useEffect(() => {
    if (!isOpen) setSortOpen(false)
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return

    const previousBodyOverflow = document.body.style.overflow
    const previousHtmlOverflow = document.documentElement.style.overflow

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
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
      : Number(averageRating)
  const safeAverage = Number.isFinite(average) ? average : 0
  const selectedSortLabel =
    sortOptions.find((option) => option.value === sort)?.label ??
    sortOptions[0].label

  const closeSortMenu = () => {
    setSortOpen(false)
    sortTriggerRef.current?.focus()
  }

  const handleSortListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const options = Array.from(
      sortListRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [],
    )
    const current = options.indexOf(document.activeElement as HTMLButtonElement)
    const moves: Record<string, number> = {
      ArrowDown: current + 1,
      ArrowUp: current - 1,
      Home: 0,
      End: options.length - 1,
    }

    if (event.key === "Escape") {
      event.stopPropagation()
      closeSortMenu()
      return
    }
    if (!(event.key in moves) || options.length === 0) return

    event.preventDefault()
    const next = (moves[event.key] + options.length) % options.length
    options[next]?.focus()
  }

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
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/85 p-3 backdrop-blur-sm sm:p-4">
          <button
            type="button"
            aria-label="Cerrar reseñas"
            title="Cerrar reseñas"
            onClick={() => setIsOpen(false)}
            className="absolute inset-0 cursor-pointer"
          />

          {/* Colores sólo con tokens de tema (--account-*): Light usa texto
              oscuro sobre superficies claras y Dark conserva el aspecto
              oscuro. Antes eran literales text-white/NN sobre
              bg-beyonix-surface, que en Light resolvía a blanco sobre blanco. */}
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="product-reviews-dialog-title"
            className="product-reviews-dialog relative z-10 flex max-h-[min(780px,calc(100vh-24px))] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-[var(--account-border)] text-[var(--account-text-primary)] shadow-[0_24px_72px_rgba(0,0,0,0.45)]"
          >
            <header className="product-reviews-dialog-header flex shrink-0 items-start justify-between gap-4 border-b border-[var(--account-border-subtle)] px-4 py-4 sm:px-6 sm:py-5">
              <div className="min-w-0">
                <p className="text-12px font-bold uppercase tracking-widest text-[var(--account-accent-soft)]">
                  Opiniones verificadas
                </p>
                <h3
                  id="product-reviews-dialog-title"
                  className="mt-1 text-xl font-black leading-tight text-[var(--account-text-primary)] sm:text-25px"
                >
                  Ver todas las reseñas
                </h3>
                <p className="mt-1 line-clamp-1 text-15px font-semibold text-[var(--account-text-secondary)]">
                  {productName}
                </p>
              </div>

              <button
                type="button"
                aria-label="Cerrar reseñas"
                title="Cerrar reseñas"
                onClick={() => setIsOpen(false)}
                className="flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-full border border-[var(--account-border)] bg-[var(--account-surface-raised)] text-[var(--account-text-primary)] transition-colors hover:border-[var(--account-border-strong)] hover:bg-[var(--account-surface-hover)] focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-[var(--account-focus-ring)]"
              >
                <X className="size-4" />
              </button>
            </header>

            <div className="product-reviews-dialog-body custom-scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-5">
              <div className="flex flex-col gap-4 rounded-xl border border-[var(--account-border)] bg-[var(--account-surface-raised)] p-4 sm:flex-row sm:items-center sm:justify-between">
                <div data-reviews-summary className="flex min-w-0 items-center gap-4">
                  {/* Promedio en azul BEYONIX (--account-accent-soft: #1E4D7B en
                      Light, #8CC8F2 en Dark) para cualquier valor. */}
                  <p className="shrink-0 leading-none">
                    <span
                      data-reviews-average
                      className="text-[32px] font-black tracking-tight text-[var(--account-accent-soft)]"
                    >
                      {formatAverage(safeAverage)}
                    </span>
                    <span className="ml-1 text-base font-bold text-[var(--account-text-secondary)]">
                      / 5
                    </span>
                  </p>
                  <span
                    className="h-10 w-px shrink-0 bg-[var(--account-border)]"
                    aria-hidden="true"
                  />
                  <div className="min-w-0">
                    <ReviewStars rating={safeAverage} />
                    <p className="mt-1 text-13px font-medium text-[var(--account-text-secondary)]">
                      {visibleReviewsCount}{" "}
                      {visibleReviewsCount === 1
                        ? "reseña verificada"
                        : "reseñas verificadas"}
                    </p>
                  </div>
                </div>

                <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 sm:shrink-0 sm:flex-nowrap">
                  <span
                    id="product-reviews-sort-label"
                    className="inline-flex shrink-0 items-center gap-1.5 text-11px font-bold uppercase tracking-widest text-[var(--account-text-secondary)]"
                  >
                    <ArrowDownWideNarrow className="size-3.5" aria-hidden="true" />
                    Ordenar por
                  </span>
                  <div
                    ref={sortMenuRef}
                    className="relative min-w-44 flex-1 sm:w-52 sm:flex-none"
                  >
                    <button
                      ref={sortTriggerRef}
                      type="button"
                      aria-label={`Ordenar reseñas: ${selectedSortLabel}`}
                      aria-haspopup="listbox"
                      aria-expanded={sortOpen}
                      aria-controls="product-reviews-sort-options"
                      title="Ordenar reseñas"
                      onClick={() => setSortOpen((current) => !current)}
                      onKeyDown={(event) => {
                        if (event.key === "ArrowDown" && !sortOpen) {
                          event.preventDefault()
                          setSortOpen(true)
                        }
                      }}
                      className={cn(
                        "flex h-10 w-full cursor-pointer items-center justify-between gap-3 rounded-lg border bg-[var(--account-surface)] px-3 text-left text-sm font-semibold text-[var(--account-text-primary)] outline-none transition-colors hover:border-[var(--account-border-strong)] hover:bg-[var(--account-surface-hover)] focus-visible:ring-3 focus-visible:ring-[var(--account-focus-ring)]",
                        sortOpen
                          ? "border-[var(--account-border-strong)]"
                          : "border-[var(--account-border)]",
                      )}
                    >
                      <span className="truncate">{selectedSortLabel}</span>
                      <ChevronDown
                        className={cn(
                          "size-4 shrink-0 text-[var(--account-text-secondary)] transition-transform",
                          sortOpen && "rotate-180",
                        )}
                        aria-hidden="true"
                      />
                    </button>

                    {sortOpen && (
                      <div
                        ref={sortListRef}
                        id="product-reviews-sort-options"
                        role="listbox"
                        aria-labelledby="product-reviews-sort-label"
                        onKeyDown={handleSortListKeyDown}
                        className="absolute right-0 top-full z-20 mt-1.5 w-full overflow-hidden rounded-xl border border-[var(--account-border)] bg-[var(--account-surface)] p-1 shadow-[0_16px_40px_rgba(15,23,42,0.18)]"
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
                                closeSortMenu()
                              }}
                              className={cn(
                                "flex h-9 w-full cursor-pointer items-center justify-between gap-3 rounded-lg px-3 text-left text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--account-focus-ring)]",
                                active
                                  ? "bg-[var(--account-accent)] font-semibold text-white"
                                  : "font-medium text-[var(--account-text-primary)] hover:bg-[var(--account-surface-hover)] focus-visible:bg-[var(--account-surface-hover)]",
                              )}
                            >
                              <span>{option.label}</span>
                              {active && (
                                <Check
                                  className="size-4 shrink-0 text-white"
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
                <div className="flex min-h-52 items-center justify-center gap-2 text-15px font-semibold text-[var(--account-text-secondary)]">
                  <LoaderCircle className="size-5 animate-spin" />
                  Cargando reseñas...
                </div>
              ) : errorMessage ? (
                <p
                  role="alert"
                  className="mt-5 rounded-xl border border-[var(--account-danger-border)] bg-[var(--account-danger-bg)] px-4 py-3 text-15px font-semibold text-[var(--account-danger-text)]"
                >
                  {errorMessage}
                </p>
              ) : visibleReviews.length === 0 ? (
                <div className="mt-5 rounded-xl border border-[var(--account-border)] bg-[var(--account-surface-raised)] px-4 py-8 text-center">
                  <MessageSquareText className="mx-auto size-6 text-[var(--account-accent-soft)]" />
                  <p className="mt-3 text-15px font-bold text-[var(--account-text-primary)]">
                    Todavía no hay reseñas para este producto
                  </p>
                </div>
              ) : (
                <div className="mt-5 grid gap-3 md:grid-cols-2">
                  {visibleReviews.map((review) => (
                    <PublicReviewCard key={review.id} review={review} />
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>
      )}
    </>
  )
}
