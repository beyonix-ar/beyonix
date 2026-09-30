"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import {
  LoaderCircle,
  MapPin,
  MessageSquareText,
  ShieldCheck,
  Star,
  Trash2,
  UserRound,
  X,
} from "lucide-react"

import {
  BeyonixButton,
  BeyonixCard,
  BeyonixEmptyState,
  BeyonixSectionHeader,
} from "@/components/beyonix-ui"
import { Textarea } from "@/components/ui/textarea"
import { formatReviewDate } from "@/lib/reviews/review-format"
import {
  REVIEW_COMMENT_MAX_LENGTH,
  REVIEW_COMMENT_MIN_LENGTH,
  validateReviewComment,
} from "@/lib/reviews/review-text"
import { getSafeSupabaseSession, supabase } from "@/lib/supabase/client"

type Review = {
  id: number
  rating: number
  comment: string
  nickname: string
  city: string
  province: string
  createdAt: string
  canDelete: boolean
}

type EligibleReview = {
  orderId: number
  nickname: string
  city: string
  province: string
}

type ReviewsSummary = {
  count: number
  average: number
}

type ReviewsResponse = {
  reviews?: Review[]
  summary?: ReviewsSummary
  eligibleReview?: EligibleReview | null
  error?: string
}

async function getAuthHeaders(): Promise<Record<string, string>> {
  const session = await getSafeSupabaseSession()
  const headers: Record<string, string> = {}

  if (session?.access_token) {
    headers.Authorization = `Bearer ${session.access_token}`
  }

  return headers
}

export function ReviewsSection() {
  const [reviews, setReviews] = useState<Review[]>([])
  const [summary, setSummary] = useState<ReviewsSummary>({ count: 0, average: 0 })
  const [eligibleReview, setEligibleReview] =
    useState<EligibleReview | null>(null)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const [errorMessage, setErrorMessage] = useState("")
  const [successMessage, setSuccessMessage] = useState("")
  const [rating, setRating] = useState(5)
  const [hover, setHover] = useState(0)
  const [comment, setComment] = useState("")

  const loadReviews = useCallback(async () => {
    try {
      const headers = await getAuthHeaders()
      const response = await fetch("/api/reviews", {
        headers,
        cache: "no-store",
      })
      const payload = (await response.json()) as ReviewsResponse

      if (!response.ok) {
        throw new Error(payload.error || "No pudimos cargar las reseñas.")
      }

      setReviews(payload.reviews ?? [])
      setSummary(payload.summary ?? { count: 0, average: 0 })
      setEligibleReview(payload.eligibleReview ?? null)
      setErrorMessage("")
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "No pudimos cargar las reseñas."
      )
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    localStorage.removeItem("beyonix-reviews")
    void loadReviews()

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(() => {
      void loadReviews()
    })

    return () => subscription.unsubscribe()
  }, [loadReviews])

  const handleAddReview = async () => {
    if (!eligibleReview || isSubmitting) return

    const commentValidation = validateReviewComment(comment)
    if (commentValidation.error) {
      setErrorMessage(commentValidation.error)
      return
    }

    setIsSubmitting(true)
    setErrorMessage("")
    setSuccessMessage("")

    try {
      const headers = await getAuthHeaders()
      const response = await fetch("/api/reviews", {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          orderId: eligibleReview.orderId,
          rating,
          comment: commentValidation.comment,
        }),
      })
      const payload = (await response.json()) as ReviewsResponse & {
        review?: Review
      }

      if (!response.ok || !payload.review) {
        throw new Error(payload.error || "No pudimos guardar la reseña.")
      }

      // Una reseña nueva no se publica en Home hasta que el Admin la destaque.
      setSummary((current) => ({
        count: current.count + 1,
        average: (current.average * current.count + rating) / (current.count + 1),
      }))
      setEligibleReview(null)
      setComment("")
      setRating(5)
      setSuccessMessage("¡Gracias por compartir tu experiencia!")
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "No pudimos guardar la reseña."
      )
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleDeleteReview = async (review: Review) => {
    if (!review.canDelete || deletingId !== null) return
    if (!window.confirm("¿Querés eliminar esta reseña?")) return

    setDeletingId(review.id)
    setErrorMessage("")

    try {
      const headers = await getAuthHeaders()
      const response = await fetch(`/api/reviews/${review.id}`, {
        method: "DELETE",
        headers,
      })
      const payload = (await response.json()) as { error?: string }

      if (!response.ok) {
        throw new Error(payload.error || "No pudimos eliminar la reseña.")
      }

      setReviews((current) => current.filter((item) => item.id !== review.id))
      await loadReviews()
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "No pudimos eliminar la reseña."
      )
    } finally {
      setDeletingId(null)
    }
  }

  const visibleReviews = reviews.slice(0, 3)
  const averageRating = summary.average.toFixed(1)

  const ReviewCard = ({ review }: { review: Review }) => {
    const dateLabel = formatReviewDate(review.createdAt)

    return (
    <BeyonixCard asChild variant="default" className="relative overflow-hidden p-6">
      <article data-testid="home-review-card">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div
            className="flex gap-1"
            role="img"
            aria-label={`${review.rating} de 5 estrellas`}
          >
            {Array.from({ length: 5 }).map((_, index) => (
              <Star
                key={index}
                className={
                  index < review.rating
                    ? "size-4 fill-amber-400 text-amber-600"
                    : "size-4 text-[var(--beyonix-text-muted)]"
                }
              />
            ))}
          </div>

          {review.canDelete && (
            <BeyonixButton
              type="button"
              aria-label="Eliminar mi reseña"
              variant="destructive"
              size="icon"
              onClick={() => void handleDeleteReview(review)}
              disabled={deletingId === review.id}
              className="size-8"
            >
              {deletingId === review.id ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <Trash2 className="size-4" />
              )}
            </BeyonixButton>
          )}
        </div>

        {review.comment.trim() && (
          <p className="mb-5 text-base font-medium leading-relaxed text-[var(--beyonix-text-primary)]">
            “{review.comment}”
          </p>
        )}

        <div className="border-t border-[var(--beyonix-border-default)] pt-4">
          <p className="flex items-center gap-2 text-sm font-semibold text-[var(--beyonix-text-primary)]">
            <UserRound className="size-4 shrink-0 text-[var(--beyonix-text-secondary)]" />
            {review.nickname}
          </p>
          <p className="mt-2 flex items-center gap-2 text-sm text-[var(--beyonix-text-secondary)]">
            <MapPin className="size-4 shrink-0 text-[var(--beyonix-text-secondary)]" />
            {review.city}, {review.province}
            {dateLabel && <span aria-hidden="true">·</span>}
            {dateLabel}
          </p>
        </div>
      </article>
    </BeyonixCard>
    )
  }

  return (
    <section className="beyonix-section-spacing">
      <div className="container mx-auto px-4 lg:px-8">
        <BeyonixSectionHeader
          align="center"
          eyebrow="Experiencias"
          title="Experiencias de compra verificadas"
          description={
            reviews.length > 0 && summary.count > 0
              ? `${averageRating}/5 basado en ${summary.count} ${
                  summary.count === 1
                    ? "experiencia verificada"
                    : "experiencias verificadas"
                }`
              : undefined
          }
        />

        {eligibleReview && (
          <BeyonixCard
            variant="highlighted"
            className="mx-auto mb-12 max-w-xl space-y-4 p-6"
          >
            <div className="space-y-2">
              <p className="beyonix-modal-title flex items-center gap-2 text-sm font-semibold text-white">
                <ShieldCheck className="size-4 text-beyonix-sky" />
                Compra verificada
              </p>
              <p className="beyonix-modal-body text-sm text-white/72">
                {eligibleReview.nickname} · {eligibleReview.city} ·{" "}
                {eligibleReview.province}
              </p>
            </div>

            <div className="flex justify-center gap-1">
              {Array.from({ length: 5 }).map((_, index) => {
                const value = index + 1

                return (
                  <button
                    key={value}
                    type="button"
                    aria-label={`Calificar con ${value} estrellas`}
                    aria-pressed={rating === value}
                    onClick={() => setRating(value)}
                    onMouseEnter={() => setHover(value)}
                    onMouseLeave={() => setHover(0)}
                    className="grid size-6 cursor-pointer place-items-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-beyonix-blue-light/35"
                  >
                    <Star
                      className={`size-3.5 transition-all ${
                        value <= (hover || rating)
                          ? "fill-beyonix-sky text-beyonix-sky"
                          : "text-beyonix-blue-light"
                      }`}
                    />
                  </button>
                )
              })}
            </div>

            <Textarea
              aria-label="Comentario sobre tu experiencia"
              placeholder={`Comentá tu experiencia en Beyonix (mín. ${REVIEW_COMMENT_MIN_LENGTH}, máx. ${REVIEW_COMMENT_MAX_LENGTH} caracteres)`}
              maxLength={REVIEW_COMMENT_MAX_LENGTH}
              required
              rows={4}
              className="beyonix-review-textarea h-28 resize-none border-beyonix-blue-light/30 bg-black/55 text-white focus-visible:border-beyonix-blue-light focus-visible:ring-beyonix-blue-light/25"
              value={comment}
              onChange={(event) => {
                setComment(event.target.value)
                setErrorMessage("")
              }}
            />

            <p className="text-right text-xs text-beyonix-sky/60">
              {comment.length}/{REVIEW_COMMENT_MAX_LENGTH}
            </p>

            <BeyonixButton
              type="button"
              aria-label="Enviar experiencia"
              onClick={() => void handleAddReview()}
              disabled={isSubmitting}
              className="w-full"
            >
              {isSubmitting ? (
                <>
                  <LoaderCircle className="size-4 animate-spin" />
                  Guardando...
                </>
              ) : (
                "Enviar experiencia"
              )}
            </BeyonixButton>
          </BeyonixCard>
        )}

        {errorMessage && (
          <p
            role="alert"
            className="mx-auto mb-8 max-w-xl rounded-xl border border-red-400/25 bg-red-500/10 px-4 py-3 text-center text-sm text-red-200"
          >
            {errorMessage}
          </p>
        )}

        {successMessage && (
          <p
            role="status"
            className="beyonix-modal-body mx-auto mb-8 max-w-xl text-center text-sm font-semibold text-[var(--beyonix-text-secondary)]"
          >
            {successMessage}
          </p>
        )}

        {isLoading ? (
          <div className="flex items-center justify-center gap-2 text-beyonix-sky/70">
            <LoaderCircle className="size-5 animate-spin" />
            Cargando reseñas...
          </div>
        ) : reviews.length === 0 ? (
          <BeyonixEmptyState
            icon={<MessageSquareText className="size-5 text-white" />}
            title="Todavía no hay experiencias publicadas"
            description="Las experiencias verificadas de nuestros clientes aparecerán en esta sección."
            action={
              <BeyonixButton asChild variant="outline">
                <Link href="/productos">Conocé nuestros productos</Link>
              </BeyonixButton>
            }
          />
        ) : (
          <>
            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {visibleReviews.map((review) => (
                <ReviewCard key={review.id} review={review} />
              ))}
            </div>

            {reviews.length > 3 && (
              <div className="mt-8 text-center">
                <BeyonixButton
                  type="button"
                  aria-label="Ver todas las reseñas"
                  variant="outline"
                  onClick={() => setIsModalOpen(true)}
                >
                  Ver todas las reseñas
                </BeyonixButton>
              </div>
            )}
          </>
        )}

        {isModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4 backdrop-blur-sm">
            <BeyonixCard
              variant="elevated"
              className="relative max-h-screen w-full max-w-4xl overflow-y-auto p-6"
            >
              <BeyonixButton
                type="button"
                aria-label="Cerrar reseñas"
                variant="icon"
                size="icon"
                className="absolute right-4 top-4"
                onClick={() => setIsModalOpen(false)}
              >
                <X className="size-5" />
              </BeyonixButton>

              <h3 className="mb-6 text-2xl font-bold text-[var(--beyonix-text-primary)]">
                Todas las reseñas
              </h3>

              <div className="grid gap-6 sm:grid-cols-2">
                {reviews.map((review) => (
                  <ReviewCard key={review.id} review={review} />
                ))}
              </div>
            </BeyonixCard>
          </div>
        )}
      </div>
    </section>
  )
}
