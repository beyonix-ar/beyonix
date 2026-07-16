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
  BeyonixIconBox,
  BeyonixSectionHeader,
} from "@/components/beyonix-ui"
import { Textarea } from "@/components/ui/textarea"
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
  const averageRating =
    reviews.length > 0
      ? (
          reviews.reduce((sum, review) => sum + review.rating, 0) /
          reviews.length
        ).toFixed(1)
      : "0.0"

  const ReviewCard = ({ review }: { review: Review }) => (
    <BeyonixCard asChild variant="default" className="relative overflow-hidden p-6">
      <article>
        <div className="mb-4 flex items-start justify-between gap-4">
          <div
            className="flex gap-1"
            aria-label={`${review.rating} de 5 estrellas`}
          >
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

        <p className="mb-5 leading-relaxed text-white/88">
          “{review.comment}”
        </p>

        <div className="border-t border-beyonix-blue-light/14 pt-4">
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
    </BeyonixCard>
  )

  return (
    <section className="beyonix-section-spacing">
      <div className="container mx-auto px-4 lg:px-8">
        <BeyonixSectionHeader
          align="center"
          eyebrow="Experiencias"
          title="Experiencias de compra verificadas"
          description={
            reviews.length > 0
              ? `${averageRating}/5 basado en ${reviews.length} ${
                  reviews.length === 1
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
                    onClick={() => setRating(value)}
                    onMouseEnter={() => setHover(value)}
                    onMouseLeave={() => setHover(0)}
                    className="cursor-pointer rounded-md outline-none focus-visible:ring-2 focus-visible:ring-beyonix-blue-light/35"
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
              placeholder="Comentá tu experiencia en Beyonix (máx. 150 caracteres)"
              maxLength={150}
              rows={4}
              className="h-28 resize-none border-beyonix-blue-light/30 bg-black/55 text-white focus-visible:border-beyonix-blue-light focus-visible:ring-beyonix-blue-light/25"
              value={comment}
              onChange={(event) => setComment(event.target.value)}
            />

            <p className="text-right text-xs text-beyonix-sky/60">
              {comment.length}/150
            </p>

            <BeyonixButton
              type="button"
              aria-label="Enviar experiencia"
              onClick={() => void handleAddReview()}
              disabled={!comment.trim() || isSubmitting}
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

              <h3 className="mb-6 text-2xl font-bold text-white">
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
