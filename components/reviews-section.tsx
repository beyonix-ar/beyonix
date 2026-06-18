"use client"

import { useCallback, useEffect, useState } from "react"
import {
  LoaderCircle,
  MapPin,
  ShieldCheck,
  Star,
  Trash2,
  UserRound,
  X,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import {
  getSafeSupabaseSession,
  supabase,
} from "@/lib/supabase/client"

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

type ReviewsResponse = {
  reviews?: Review[]
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
  const [eligibleReview, setEligibleReview] =
    useState<EligibleReview | null>(null)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const [errorMessage, setErrorMessage] = useState("")
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
    if (!eligibleReview || !comment.trim() || isSubmitting) return

    setIsSubmitting(true)
    setErrorMessage("")

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
          comment,
        }),
      })
      const payload = (await response.json()) as ReviewsResponse & {
        review?: Review
      }

      if (!response.ok || !payload.review) {
        throw new Error(payload.error || "No pudimos guardar la reseña.")
      }

      setReviews((current) => [payload.review!, ...current])
      setEligibleReview(null)
      setComment("")
      setRating(5)
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

      setReviews((current) =>
        current.filter((item) => item.id !== review.id)
      )
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
  const averageRating =
    reviews.length > 0
      ? (
          reviews.reduce((sum, review) => sum + review.rating, 0) /
          reviews.length
        ).toFixed(1)
      : "0.0"

  const ReviewCard = ({ review }: { review: Review }) => (
    <article className="relative overflow-hidden rounded-2xl border border-beyonix-blue-light/25 bg-beyonix-surface p-6 shadow-xl shadow-black/25">
      <div className="absolute inset-x-0 top-0 h-1 bg-linear-to-r from-beyonix-blue via-beyonix-cyan to-beyonix-blue" />

      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="flex gap-1" aria-label={`${review.rating} de 5 estrellas`}>
          {Array.from({ length: 5 }).map((_, index) => (
            <Star
              key={index}
              className={
                index < review.rating
                  ? "size-4 fill-beyonix-sky text-beyonix-sky"
                  : "size-4 text-beyonix-blue-light/50"
              }
            />
          ))}
        </div>

        {review.canDelete && (
          <button
            type="button"
            aria-label="Eliminar mi reseña"
            title="Eliminar mi reseña"
            onClick={() => void handleDeleteReview(review)}
            disabled={deletingId === review.id}
            className="flex size-8 cursor-pointer items-center justify-center rounded-lg border border-red-400/20 bg-red-500/8 text-red-300 transition-colors hover:bg-red-500/15 hover:text-red-200 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {deletingId === review.id ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <Trash2 className="size-4" />
            )}
          </button>
        )}
      </div>

      <p className="mb-5 leading-relaxed text-white/90">
        “{review.comment}”
      </p>

      <div className="border-t border-beyonix-blue-light/20 pt-4">
        <p className="flex items-center gap-2 text-sm font-semibold text-white">
          <UserRound className="size-4 text-beyonix-sky" />
          {review.nickname}
        </p>
        <p className="mt-2 flex items-center gap-2 text-sm text-white/58">
          <MapPin className="size-4 text-beyonix-cyan" />
          {review.city} · {review.province}
        </p>
      </div>
    </article>
  )

  return (
    <section className="py-16 lg:py-24">
      <div className="container mx-auto px-4 lg:px-8">
        <div className="mb-12 text-center lg:mb-16">
          <p className="mb-3 text-sm font-medium uppercase tracking-widest text-beyonix-cyan">
            Reseñas
          </p>
          <h2 className="mb-4 text-3xl font-bold text-white lg:text-5xl">
            Opiniones verificadas
          </h2>
          {reviews.length > 0 && (
            <p className="text-sm text-beyonix-sky/70">
              {averageRating}/5 basado en {reviews.length}{" "}
              {reviews.length === 1 ? "reseña verificada" : "reseñas verificadas"}
            </p>
          )}
        </div>

        {eligibleReview && (
          <div className="mx-auto mb-12 max-w-xl space-y-4 rounded-2xl border border-beyonix-blue-light/35 bg-beyonix-blue/20 p-6 shadow-2xl shadow-black/30">
            <div className="space-y-2">
              <p className="flex items-center gap-2 text-sm font-semibold text-white">
                <ShieldCheck className="size-4 text-beyonix-sky" />
                Compra verificada
              </p>
              <p className="text-sm text-white/72">
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
                    title={`Calificar con ${value} estrellas`}
                    onClick={() => setRating(value)}
                    onMouseEnter={() => setHover(value)}
                    onMouseLeave={() => setHover(0)}
                    className="cursor-pointer"
                  >
                    <Star
                      className={`size-6 transition-all ${
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
              placeholder="Comentá tu experiencia (máx. 150 caracteres)"
              maxLength={150}
              rows={4}
              className="h-28 resize-none border-beyonix-blue-light/30 bg-black/55 text-white focus-visible:border-beyonix-cyan focus-visible:ring-beyonix-blue/60"
              value={comment}
              onChange={(event) => setComment(event.target.value)}
            />

            <p className="text-right text-xs text-beyonix-sky/60">
              {comment.length}/150
            </p>

            <Button
              type="button"
              aria-label="Enviar reseña"
              title="Enviar reseña"
              onClick={() => void handleAddReview()}
              disabled={!comment.trim() || isSubmitting}
              className="w-full cursor-pointer bg-beyonix-blue text-white hover:bg-beyonix-blue-hover disabled:cursor-not-allowed"
            >
              {isSubmitting ? (
                <>
                  <LoaderCircle className="size-4 animate-spin" />
                  Guardando...
                </>
              ) : (
                "Enviar reseña"
              )}
            </Button>
          </div>
        )}

        {errorMessage && (
          <p
            role="alert"
            className="mx-auto mb-8 max-w-xl rounded-xl border border-red-400/25 bg-red-500/10 px-4 py-3 text-center text-sm text-red-200"
          >
            {errorMessage}
          </p>
        )}

        {isLoading ? (
          <div className="flex items-center justify-center gap-2 text-beyonix-sky/70">
            <LoaderCircle className="size-5 animate-spin" />
            Cargando reseñas...
          </div>
        ) : reviews.length === 0 ? (
          <div className="text-center text-beyonix-sky/60">
            Sé el primero en dejar una reseña.
          </div>
        ) : (
          <>
            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {visibleReviews.map((review) => (
                <ReviewCard key={review.id} review={review} />
              ))}
            </div>

            {reviews.length > 3 && (
              <div className="mt-8 text-center">
                <Button
                  type="button"
                  aria-label="Ver todas las reseñas"
                  title="Ver todas las reseñas"
                  variant="outline"
                  onClick={() => setIsModalOpen(true)}
                  className="cursor-pointer border-beyonix-blue-light/35 bg-beyonix-blue/15 text-white hover:bg-beyonix-blue/30"
                >
                  Ver todas las reseñas
                </Button>
              </div>
            )}
          </>
        )}

        {isModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4 backdrop-blur-sm">
            <div className="relative max-h-screen w-full max-w-4xl overflow-y-auto rounded-2xl border border-beyonix-blue-light/30 bg-beyonix-surface p-6 shadow-2xl shadow-black/60">
              <Button
                type="button"
                aria-label="Cerrar reseñas"
                title="Cerrar reseñas"
                variant="ghost"
                size="icon"
                className="absolute right-4 top-4 cursor-pointer text-beyonix-sky hover:bg-beyonix-blue/30"
                onClick={() => setIsModalOpen(false)}
              >
                <X className="size-5" />
              </Button>

              <h3 className="mb-6 text-2xl font-bold text-white">
                Todas las reseñas
              </h3>

              <div className="grid gap-6 sm:grid-cols-2">
                {reviews.map((review) => (
                  <ReviewCard key={review.id} review={review} />
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
