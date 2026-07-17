"use client"

import { useEffect, useState } from "react"
import { Bell, Check, ExternalLink, Package, Sparkles, Star } from "lucide-react"

import { BeyonixButton } from "@/components/account/account-ui"
import { supabase } from "@/lib/supabase/client"
import { formatPublicOrderId } from "@/lib/account/account-formatters"
import { cn } from "@/lib/utils"
import {
  getCuentaItemImage,
  getOrderProgressSteps,
  normalizeTrackingUrl,
  type OrderProgressTone,
} from "@/lib/account/account-utils"
import type { SupabasePedido } from "@/lib/supabase/types"

export const DOWNLOADED_INVOICES_STORAGE_KEY = "beyonix:downloaded-invoices"
const REVIEW_ACTION_PLACEHOLDER_CLASS =
  "h-8 w-40 shrink-0 animate-pulse rounded-lg bg-beyonix-gray-700"

function ReviewRatingSelector({
  label,
  selectedRating,
  visualRating,
  onPreview,
  onSelect,
}: {
  label: string
  selectedRating: number
  visualRating: number
  onPreview: (rating: number | null) => void
  onSelect: (rating: number) => void
}) {
  return (
    <div
      role="group"
      aria-label={label}
      onMouseLeave={() => onPreview(null)}
      className="inline-flex h-9 shrink-0 items-center gap-1 rounded-lg border border-beyonix-blue-500/45 bg-beyonix-gray-900 px-2"
    >
      {[1, 2, 3, 4, 5].map((rating) => {
        const active = rating <= visualRating

        return (
          <button
            key={rating}
            type="button"
            aria-label={`${rating} ${rating === 1 ? "estrella" : "estrellas"}`}
            title={`${rating} de 5 estrellas`}
            aria-pressed={selectedRating === rating}
            onMouseEnter={() => onPreview(rating)}
            onFocus={() => onPreview(rating)}
            onBlur={() => onPreview(null)}
            onClick={() => onSelect(rating)}
            className={cn(
              "grid size-6 cursor-pointer place-items-center focus:outline-none focus-visible:ring-1 focus-visible:ring-white",
              active
                ? "text-beyonix-sky"
                : "text-beyonix-gray-500 hover:text-white",
            )}
          >
            <Star
              className={cn(
                "size-3.5",
                active ? "fill-current" : "fill-transparent",
              )}
            />
          </button>
        )
      })}
    </div>
  )
}

export function CustomerInvoiceBell() {
  return (
    <span
      className="inline-flex size-5 items-center justify-center rounded-full border border-red-300/45 bg-red-500 text-white shadow-lg shadow-red-950/35"
    >
      <Bell className="size-3" />
    </span>
  )
}

export function OrderProgressTimeline({ order }: { order: SupabasePedido }) {
  const steps = getOrderProgressSteps(order)
  const circleToneClassNames: Record<OrderProgressTone, string> = {
    done: "border-beyonix-status-success/45 bg-beyonix-status-success/12 text-beyonix-status-success",
    current: "border-beyonix-blue-300 bg-beyonix-blue-700 text-white",
    pending: "border-beyonix-gray-700 bg-beyonix-gray-900 text-beyonix-gray-500",
    danger: "border-beyonix-status-danger/45 bg-beyonix-status-danger/10 text-beyonix-status-danger",
    warning: "border-beyonix-blue-300 bg-beyonix-blue-700 text-white",
  }
  const labelToneClassNames: Record<OrderProgressTone, string> = {
    done: "text-white",
    current: "text-white",
    pending: "text-beyonix-gray-500",
    danger: "text-white",
    warning: "text-white",
  }
  const gridClassName =
    steps.length >= 6
      ? "md:grid-cols-6"
      : steps.length === 4
        ? "md:grid-cols-4"
        : steps.length === 2
          ? "md:grid-cols-2"
          : "md:grid-cols-5"

  return (
    <section className="rounded-xl border border-beyonix-blue-500/60 bg-beyonix-gray-900 px-4 py-3">
      <p className="text-10px font-black uppercase tracking-widest text-white">
        Estado del pedido
      </p>
      <ol className={"mt-2 grid " + gridClassName}>
        {steps.map((step, index) => {
          const previousCompleted =
            index > 0 && steps[index - 1]?.tone === "done"
          const currentCompleted = step.tone === "done"
          const isLastStep = index === steps.length - 1

          return (
            <li
              key={step.label + "-" + index}
              aria-current={
                step.tone === "current" || step.tone === "warning"
                  ? "step"
                  : undefined
              }
              className="flex min-w-0 items-stretch gap-3 md:block"
            >
              <div className="flex shrink-0 flex-col items-center md:flex-row">
                <span
                  aria-hidden="true"
                  className={`hidden h-px flex-1 md:block ${
                    index === 0
                      ? "bg-transparent"
                      : previousCompleted
                        ? "bg-beyonix-status-success/65"
                        : "bg-beyonix-gray-700"
                  }`}
                />
                <span
                  className={`flex size-8 shrink-0 items-center justify-center rounded-full border text-10px font-black ${circleToneClassNames[step.tone]}`}
                >
                  {currentCompleted ? (
                    <Check className="size-3.5" aria-hidden="true" />
                  ) : (
                    index + 1
                  )}
                </span>
                {!isLastStep && (
                  <span
                    aria-hidden="true"
                    className={`w-px flex-1 md:hidden ${
                      currentCompleted
                        ? "bg-beyonix-status-success/65"
                        : "bg-beyonix-gray-700"
                    }`}
                  />
                )}
                <span
                  aria-hidden="true"
                  className={`hidden h-px flex-1 md:block ${
                    isLastStep
                      ? "bg-transparent"
                      : currentCompleted
                        ? "bg-beyonix-status-success/65"
                        : "bg-beyonix-gray-700"
                  }`}
                />
              </div>

              <div
                className={`min-w-0 pt-0.5 md:px-2 md:pb-0 md:pt-1.5 md:text-center ${
                  isLastStep ? "pb-0" : "pb-3"
                }`}
              >
                <p
                  className={`text-11px font-black ${labelToneClassNames[step.tone]}`}
                >
                  {step.label}
                </p>
              </div>
            </li>
          )
        })}
      </ol>
    </section>
  )
}

export function OrderTrackingPanel({ order }: { order: SupabasePedido }) {
  const trackingNumber = order.andreani_tracking || order.tracking_number || ""
  const trackingUrl = normalizeTrackingUrl(order.tracking_url)

  if (!trackingNumber && !trackingUrl) return null

  return (
    <div className="mb-3 rounded-xl border border-beyonix-blue-light/20 bg-beyonix-blue/12 p-2.5">
      <p className="text-11px font-black uppercase tracking-widest text-beyonix-cyan">
        Seguimiento del envío
      </p>
      <div className="mt-2 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-stretch">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-white/45">
            Número de seguimiento
          </p>
          <p className="mt-1 break-all text-sm font-black text-white">
            {trackingNumber || "Pendiente"}
          </p>
        </div>
        {trackingUrl && (
          <BeyonixButton asChild size="sm" className="shrink-0 self-center">
            <a
              href={trackingUrl}
              target="_blank"
              rel="noreferrer"
            >
              Ver seguimiento
            </a>
          </BeyonixButton>
        )}
      </div>
    </div>
  )
}

export function PaymentProofViewButton({
  order,
  className = "",
}: {
  order: SupabasePedido
  className?: string
}) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    setError("")
  }, [order.id, order.payment_proof_uploaded_at])

  const handleOpenProof = async () => {
    setLoading(true)
    setError("")

    try {
      const response = await fetch(`/api/payment-proofs/${order.id}`)
      const data = (await response.json()) as {
        signedUrl?: string | null
        error?: string
      }

      if (!response.ok || !data.signedUrl) {
        throw new Error(data.error || "No se pudo abrir el comprobante.")
      }

      const anchor = document.createElement("a")
      anchor.href = data.signedUrl
      anchor.target = "_blank"
      anchor.rel = "noreferrer"
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
    } catch (proofError) {
      setError(
        proofError instanceof Error
          ? proofError.message
          : "No se pudo abrir el comprobante.",
      )
    } finally {
      setLoading(false)
    }
  }

  return (
    <span className="flex w-full flex-col items-stretch gap-1">
      <BeyonixButton
        type="button"
        aria-label={`Ver comprobante del pedido ${formatPublicOrderId(order.id)}`}
        title="Ver comprobante"
        disabled={loading}
        onClick={() => void handleOpenProof()}
        size="md"
        className={className}
      >
        <ExternalLink className="size-4" />
        {loading ? "Abriendo..." : "Ver comprobante"}
      </BeyonixButton>
      {error && (
        <span className="max-w-52 text-left text-10px font-semibold leading-4 text-red-300 sm:text-right">
          {error}
        </span>
      )}
    </span>
  )
}

export function OrderProductFeedback({ order }: { order: SupabasePedido }) {
  const items = order.orden_items ?? []
  const [ratings, setRatings] = useState<Record<number, number>>({})
  const [comments, setComments] = useState<Record<number, string>>({})
  const [activeProductId, setActiveProductId] = useState<number | null>(null)
  const [hoverRatings, setHoverRatings] = useState<Record<number, number>>({})
  const [submitted, setSubmitted] = useState<Set<number>>(() => new Set())
  const [reviewsLoaded, setReviewsLoaded] = useState(false)
  const [submitting, setSubmitting] = useState<number | null>(null)
  const [feedbackMessage, setFeedbackMessage] = useState("")

  useEffect(() => {
    let active = true
    setRatings({})
    setComments({})
    setActiveProductId(null)
    setHoverRatings({})
    setSubmitted(new Set())
    setReviewsLoaded(false)
    setFeedbackMessage("")

    const loadOwnReviews = async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession()
        const response = await fetch(`/api/reviews?orderId=${order.id}`, {
          headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
          cache: "no-store",
        })
        const data = (await response.json()) as {
          ownProductReviews?: Array<{ product_id: number; rating: number; comment: string }>
        }
        if (!active || !response.ok) return
        const reviews = data.ownProductReviews ?? []
        setSubmitted(new Set(reviews.map((review) => Number(review.product_id))))
        setRatings(Object.fromEntries(reviews.map((review) => [Number(review.product_id), Number(review.rating)])))
        setComments(Object.fromEntries(reviews.map((review) => [Number(review.product_id), String(review.comment)])))
      } finally {
        if (active) setReviewsLoaded(true)
      }
    }
    void loadOwnReviews()
    return () => { active = false }
  }, [order.id])

  const submitReview = async (productId: number) => {
    const rating = ratings[productId]
    const comment = comments[productId]?.trim() ?? ""
    if (!rating) {
      setFeedbackMessage("Elegí una puntuación para enviar la reseña.")
      return
    }

    setSubmitting(productId)
    setFeedbackMessage("")
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const response = await fetch("/api/reviews", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({ orderId: order.id, productId, rating, comment }),
      })
      const data = (await response.json()) as { error?: string }
      if (!response.ok) {
        setFeedbackMessage(data.error || "No pudimos guardar la reseña.")
        return
      }
      setSubmitted((current) => new Set(current).add(productId))
      setActiveProductId(null)
      setFeedbackMessage("¡Gracias por compartir tu experiencia!")
    } catch {
      setFeedbackMessage("No pudimos guardar la reseña. Intentá nuevamente.")
    } finally {
      setSubmitting(null)
    }
  }

  return (
    <section className="rounded-lg border border-beyonix-blue-500/50 bg-beyonix-gray-900 p-3">
      <header className="flex items-center gap-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-beyonix-blue-500/45 bg-beyonix-blue-900 text-white">
          <Package className="size-3.5" />
        </span>
        <div>
          <p className="text-8px font-semibold uppercase tracking-widest text-beyonix-gray-300">
            Producto
          </p>
          <h4 className="mt-0.5 text-sm font-bold text-white">
            Reseña del producto
          </h4>
        </div>
      </header>

      <div className="mt-3 space-y-2">
        {items.map((item) => {
          const productId = Number(item.producto_id)
          const productName = item.productos?.nombre ?? `Producto #${productId}`
          const image = getCuentaItemImage(item)
          const selectedRating = ratings[productId] ?? 0
          const visualRating = hoverRatings[productId] ?? selectedRating
          return (
            <article
              key={item.id}
              className="rounded-lg border border-beyonix-blue-500/35 bg-beyonix-blue-900 p-2.5"
            >
              <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-beyonix-gray-700 bg-white">
                    {image ? (
                      <img
                        src={image}
                        alt={productName}
                        className="size-full object-contain"
                      />
                    ) : (
                      <Package className="size-4 text-black/30" />
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="text-8px font-medium uppercase tracking-widest text-beyonix-gray-300">
                      Tu compra
                    </p>
                    <p className="mt-0.5 truncate text-xs font-semibold text-white">
                      {productName}
                    </p>
                  </div>
                </div>
                {!reviewsLoaded ? (
                  <span
                    className={REVIEW_ACTION_PLACEHOLDER_CLASS}
                    aria-hidden="true"
                  />
                ) : submitted.has(productId) ? (
                  <span className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-beyonix-status-success/35 bg-beyonix-status-success/10 px-2.5 text-10px font-semibold text-beyonix-status-success">
                    <Check className="size-3" />
                    Enviada · {selectedRating}/5
                  </span>
                ) : (
                  <ReviewRatingSelector
                    label={`Calificar ${productName}`}
                    selectedRating={selectedRating}
                    visualRating={visualRating}
                    onPreview={(rating) =>
                      setHoverRatings((current) => {
                        const next = { ...current }
                        if (rating === null) {
                          delete next[productId]
                        } else {
                          next[productId] = rating
                        }
                        return next
                      })
                    }
                    onSelect={(rating) => {
                      setRatings((current) => ({ ...current, [productId]: rating }))
                      setActiveProductId(productId)
                      setFeedbackMessage("")
                    }}
                  />
                )}
              </div>
              {reviewsLoaded && activeProductId === productId && !submitted.has(productId) && (
                <div className="mt-3 border-t border-beyonix-blue-500/30 pt-2.5">
                  <div className="flex items-center justify-between gap-3">
                    <label
                      htmlFor={`product-review-${order.id}-${productId}`}
                      className="text-9px font-medium text-beyonix-gray-300"
                    >
                      Comentario opcional
                    </label>
                    <span className="text-8px font-medium text-beyonix-gray-500">
                      {(comments[productId] ?? "").length}/150
                    </span>
                  </div>
                  <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
                    <input
                      id={`product-review-${order.id}-${productId}`}
                      value={comments[productId] ?? ""}
                      maxLength={150}
                      onChange={(event) =>
                        setComments((current) => ({
                          ...current,
                          [productId]: event.target.value,
                        }))
                      }
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" || event.nativeEvent.isComposing) return
                        event.preventDefault()
                        if (submitting === productId || !ratings[productId]) return
                        void submitReview(productId)
                      }}
                      placeholder="Escribí tu opinión"
                      className="h-9 min-w-0 flex-1 rounded-lg border border-beyonix-blue-500/40 bg-beyonix-gray-900 px-3 text-11px font-normal text-white outline-none placeholder:text-beyonix-gray-500 focus:border-beyonix-blue-300"
                    />
                    <button
                      type="button"
                      aria-label={`Enviar reseña de ${productName}`}
                      title="Enviar reseña"
                      disabled={submitting === productId}
                      onClick={() => void submitReview(productId)}
                      className="inline-flex h-9 cursor-pointer items-center justify-center gap-2 rounded-lg border border-beyonix-blue-500/55 bg-beyonix-blue-700 px-4 text-10px font-bold text-white transition-colors hover:border-beyonix-blue-300 hover:bg-beyonix-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {submitting === productId ? "Enviando..." : "Enviar reseña"}
                    </button>
                  </div>
                </div>
              )}
            </article>
          )
        })}
      </div>
      {feedbackMessage && (
        <p role="status" className="mt-2 text-10px font-medium text-beyonix-gray-300">
          {feedbackMessage}
        </p>
      )}
    </section>
  )
}

type OwnExperienceReview = {
  id?: number
  rating: number
  comment: string
}

export function OrderExperienceFeedback({ order }: { order: SupabasePedido }) {
  const [rating, setRating] = useState(0)
  const [hoverRating, setHoverRating] = useState(0)
  const [comment, setComment] = useState("")
  const [submittedReview, setSubmittedReview] =
    useState<OwnExperienceReview | null>(null)
  const [activeExperience, setActiveExperience] = useState(false)
  const [experienceLoaded, setExperienceLoaded] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [feedbackMessage, setFeedbackMessage] = useState("")

  useEffect(() => {
    let active = true
    setRating(0)
    setHoverRating(0)
    setComment("")
    setSubmittedReview(null)
    setActiveExperience(false)
    setExperienceLoaded(false)
    setFeedbackMessage("")

    const loadOwnExperience = async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession()
        const response = await fetch(`/api/reviews?orderId=${order.id}`, {
          headers: session?.access_token
            ? { Authorization: `Bearer ${session.access_token}` }
            : {},
          cache: "no-store",
        })
        const data = (await response.json()) as {
          ownExperienceReview?: OwnExperienceReview | null
        }

        if (!active) return

        if (response.ok && data.ownExperienceReview) {
          const ownReview = data.ownExperienceReview
          setSubmittedReview({
            id: ownReview.id,
            rating: Number(ownReview.rating),
            comment: String(ownReview.comment ?? ""),
          })
          setRating(Number(ownReview.rating))
          setComment(String(ownReview.comment ?? ""))
        }
      } finally {
        if (active) setExperienceLoaded(true)
      }
    }

    void loadOwnExperience()

    return () => {
      active = false
    }
  }, [order.id])

  const submitExperience = async () => {
    const trimmedComment = comment.trim()

    if (!rating) {
      setFeedbackMessage("Elegí una puntuación para enviar tu experiencia.")
      return
    }

    setSubmitting(true)
    setFeedbackMessage("")

    try {
      const { data: { session } } = await supabase.auth.getSession()
      const response = await fetch("/api/reviews", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session?.access_token
            ? { Authorization: `Bearer ${session.access_token}` }
            : {}),
        },
        body: JSON.stringify({
          orderId: order.id,
          rating,
          comment: trimmedComment,
        }),
      })
      const data = (await response.json()) as {
        review?: OwnExperienceReview
        error?: string
      }

      if (!response.ok || !data.review) {
        setFeedbackMessage(data.error || "No pudimos guardar tu experiencia.")
        return
      }

      setSubmittedReview({
        id: data.review.id,
        rating,
        comment: trimmedComment,
      })
      setActiveExperience(false)
      setFeedbackMessage("¡Gracias por compartir tu experiencia!")
    } catch {
      setFeedbackMessage("No pudimos guardar tu experiencia. Intentá nuevamente.")
    } finally {
      setSubmitting(false)
    }
  }

  const visualRating = hoverRating || rating

  return (
    <section className="rounded-lg border border-beyonix-blue-500/50 bg-beyonix-gray-900 p-3">
      <header className="flex items-center gap-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-beyonix-blue-500/45 bg-beyonix-blue-900 text-white">
          <Sparkles className="size-3.5" />
        </span>
        <div>
          <p className="text-8px font-semibold uppercase tracking-widest text-beyonix-gray-300">
            Servicio
          </p>
          <h4 className="mt-0.5 text-sm font-bold text-white">
            Experiencia en BEYONIX
          </h4>
        </div>
      </header>

      <div className="mt-3">
        <article className="rounded-lg border border-beyonix-blue-500/35 bg-beyonix-blue-900 p-2.5">
          <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-beyonix-blue-500/45 bg-beyonix-gray-900 text-white">
                <Sparkles className="size-4" />
              </div>
              <div className="min-w-0">
                <p className="text-8px font-medium uppercase tracking-widest text-beyonix-gray-300">
                  Tu experiencia
                </p>
                <p className="mt-0.5 truncate text-xs font-semibold text-white">
                  Compra, atención y navegación
                </p>
              </div>
            </div>

            {!experienceLoaded ? (
              <span
                className={REVIEW_ACTION_PLACEHOLDER_CLASS}
                aria-hidden="true"
              />
            ) : submittedReview ? (
              <span className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-beyonix-status-success/35 bg-beyonix-status-success/10 px-2.5 text-10px font-semibold text-beyonix-status-success">
                <Check className="size-3" />
                Enviada · {rating}/5
              </span>
            ) : (
              <ReviewRatingSelector
                label="Calificar experiencia en BEYONIX"
                selectedRating={rating}
                visualRating={visualRating}
                onPreview={(value) => setHoverRating(value ?? 0)}
                onSelect={(value) => {
                  setRating(value)
                  setActiveExperience(true)
                  setFeedbackMessage("")
                }}
              />
            )}
          </div>

          {experienceLoaded && activeExperience && !submittedReview && (
            <div className="mt-3 border-t border-beyonix-blue-500/30 pt-2.5">
              <div className="flex items-center justify-between gap-3">
                <label
                  htmlFor={`experience-review-${order.id}`}
                  className="text-9px font-medium text-beyonix-gray-300"
                >
                  Comentario opcional
                </label>
                <span className="text-8px font-medium text-beyonix-gray-500">
                  {comment.length}/150
                </span>
              </div>
              <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
                <input
                  id={`experience-review-${order.id}`}
                  value={comment}
                  maxLength={150}
                  onChange={(event) => {
                    setComment(event.target.value)
                    setFeedbackMessage("")
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" || event.nativeEvent.isComposing) return
                    event.preventDefault()
                    if (submitting || !rating) return
                    void submitExperience()
                  }}
                  placeholder="Escribí tu opinión"
                  className="h-9 min-w-0 flex-1 rounded-lg border border-beyonix-blue-500/40 bg-beyonix-gray-900 px-3 text-11px font-normal text-white outline-none placeholder:text-beyonix-gray-500 focus:border-beyonix-blue-300"
                />
                <button
                  type="button"
                  aria-label="Enviar experiencia en BEYONIX"
                  title="Enviar experiencia"
                  disabled={submitting || !rating}
                  onClick={() => void submitExperience()}
                  className="inline-flex h-9 cursor-pointer items-center justify-center gap-2 rounded-lg border border-beyonix-blue-500/55 bg-beyonix-blue-700 px-4 text-10px font-bold text-white transition-colors hover:border-beyonix-blue-300 hover:bg-beyonix-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {submitting ? "Enviando..." : "Enviar experiencia"}
                </button>
              </div>
            </div>
          )}
        </article>
      </div>

      {feedbackMessage && (
        <p role="status" className="mt-2 text-10px font-medium text-beyonix-gray-300">
          {feedbackMessage}
        </p>
      )}
    </section>
  )
}
