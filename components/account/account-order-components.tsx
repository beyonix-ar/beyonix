"use client"

import { useEffect, useState } from "react"
import { Bell, Check, ExternalLink, Package, Sparkles, Star } from "lucide-react"

import { BeyonixButton } from "@/components/account/account-ui"
import { supabase } from "@/lib/supabase/client"
import { formatPublicOrderId } from "@/lib/account/account-formatters"
import {
  getCuentaItemImage,
  getOrderProgressSteps,
  normalizeTrackingUrl,
  type OrderProgressTone,
} from "@/lib/account/account-utils"
import type { SupabasePedido } from "@/lib/supabase/types"

export const DOWNLOADED_INVOICES_STORAGE_KEY = "beyonix:downloaded-invoices"
const REVIEW_ACTION_PLACEHOLDER_CLASS = "h-[38px] w-[172px] shrink-0"

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
  const toneClassNames: Record<OrderProgressTone, string> = {
    done: "border-emerald-400/35 bg-[#102A22] text-emerald-200",
    current: "border-[#2C6CA3] bg-[#183654] text-white",
    pending: "border-[#21476B] bg-[#13263B] text-[#9EB4C8]",
    danger: "border-red-400/35 bg-[#2A1218] text-red-200",
    warning: "border-amber-300/35 bg-[#2A2212] text-amber-200",
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
    <div className="rounded-xl border border-transparent bg-[#0B1118] p-1.5">
      <p className="mb-1.5 text-10px font-black uppercase tracking-widest text-[#9EB4C8]">
        Estado del pedido
      </p>
      <div className={"grid gap-2 " + gridClassName}>
        {steps.map((step, index) => (
          <div
            key={step.label + "-" + index}
            className={"relative rounded-lg border px-2 py-2 " + toneClassNames[step.tone]}
          >
            <span className="mb-1 flex size-5 items-center justify-center rounded-full border border-current text-10px font-black">
              {step.tone === "done" ? <Check className="size-3" /> : index + 1}
            </span>
            <p className="text-11px font-black text-white">{step.label}</p>
            <p className="mt-0.5 text-10px leading-4 text-white/52">
              {step.detail}
            </p>
          </div>
        ))}
      </div>
    </div>
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
    <section className="rounded-xl border border-[#18334D] bg-[#101923] p-3">
      <h4 className="text-sm font-black text-white">Reseña del producto</h4>
      <div className="mt-2 space-y-2">
        {items.map((item) => {
          const productId = Number(item.producto_id)
          const productName = item.productos?.nombre ?? `Producto #${productId}`
          const image = getCuentaItemImage(item)
          const selectedRating = ratings[productId] ?? 0
          const visualRating = hoverRatings[productId] ?? selectedRating
          return (
            <div key={item.id} className="rounded-lg border border-[#21476B] bg-[#13263B] p-2.5">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-white">{image ? <img src={image} alt={productName} className="size-full object-contain" /> : <Package className="size-4 text-black/30" />}</div>
                  <p className="truncate text-xs font-black text-white">{productName}</p>
                </div>
                {!reviewsLoaded ? (
                  <span
                    className={REVIEW_ACTION_PLACEHOLDER_CLASS}
                    aria-hidden="true"
                  />
                ) : submitted.has(productId) ? (
                  <span className="inline-flex items-center gap-1.5 text-xs font-bold text-emerald-300">
                    <Check className="size-3.5" />
                    Reseña enviada
                  </span>
                ) : (
                  <div
                    className="flex items-center gap-1 rounded-lg border border-[#697684] bg-[#8794A2] px-2 py-1"
                    aria-label={`Calificar ${productName}`}
                    onMouseLeave={() =>
                      setHoverRatings((current) => {
                        const next = { ...current }
                        delete next[productId]
                        return next
                      })
                    }
                  >
                    {[1, 2, 3, 4, 5].map((rating) => {
                      const active = rating <= visualRating
                      return (
                        <button
                          key={rating}
                          type="button"
                          aria-label={`${rating} estrellas`}
                          aria-pressed={selectedRating === rating}
                          onMouseEnter={() =>
                            setHoverRatings((current) => ({ ...current, [productId]: rating }))
                          }
                          onFocus={() =>
                            setHoverRatings((current) => ({ ...current, [productId]: rating }))
                          }
                          onBlur={() =>
                            setHoverRatings((current) => {
                              const next = { ...current }
                              delete next[productId]
                              return next
                            })
                          }
                          onClick={() => {
                            setRatings((current) => ({ ...current, [productId]: rating }))
                            setActiveProductId(productId)
                            setFeedbackMessage("")
                          }}
                          className={`grid size-7 cursor-pointer place-items-center rounded-md transition-transform duration-150 hover:-translate-y-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#7AB8FF] ${
                            active ? "text-[#0067C9]" : "text-white"
                          }`}
                        >
                          <Star
                            className={`size-4 fill-transparent transition-all duration-150 ${
                              active
                                ? "drop-shadow-[0_0_4px_rgba(0,103,201,0.55)]"
                                : "drop-shadow-none"
                            }`}
                          />
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
              {reviewsLoaded && activeProductId === productId && !submitted.has(productId) && (
                <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                  <input
                    value={comments[productId] ?? ""}
                    maxLength={150}
                    onChange={(event) =>
                      setComments((current) => ({ ...current, [productId]: event.target.value }))
                    }
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" || event.nativeEvent.isComposing) return
                      event.preventDefault()
                      if (submitting === productId || !ratings[productId]) return
                      void submitReview(productId)
                    }}
                    placeholder="Contanos brevemente tu experiencia"
                    className="h-10 min-w-0 flex-1 rounded-lg border border-[#9AA9B8] bg-[#E7EDF3] px-3 text-xs font-semibold text-[#0B1118] outline-none placeholder:text-[#5F6B78] focus:border-[#6EC6FF] focus:ring-2 focus:ring-[#6EC6FF]/35"
                  />
                  <button
                    type="button"
                    disabled={submitting === productId}
                    onClick={() => void submitReview(productId)}
                    className="h-10 cursor-pointer rounded-lg border border-[#21476B] bg-[#112A43] px-4 text-xs font-black text-white transition-colors duration-150 hover:border-[#2C6CA3] hover:bg-[#183654] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {submitting === productId ? "Enviando..." : "Enviar reseña"}
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>
      {feedbackMessage && <p className="mt-2 text-xs font-bold text-white/70">{feedbackMessage}</p>}
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
    <section className="rounded-xl border border-[#18334D] bg-[#101923] p-3">
      <h4 className="text-sm font-black text-white">Experiencia en BEYONIX</h4>
      <div className="mt-2 space-y-2">
        <div className="rounded-lg border border-[#21476B] bg-[#13263B] p-2.5">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-[#2C6CA3]/70 bg-[#0B2A44] text-white shadow-[0_0_18px_rgba(122,184,255,0.16)]">
                <Sparkles className="size-4" />
              </div>
              <div className="min-w-0">
                <p className="truncate text-xs font-black text-white">
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
              <span className="inline-flex items-center gap-1.5 text-xs font-bold text-emerald-300">
                <Check className="size-3.5" />
                Experiencia enviada
              </span>
            ) : (
              <div
                className="flex items-center gap-1 rounded-lg border border-[#697684] bg-[#8794A2] px-2 py-1"
                aria-label="Calificar experiencia en BEYONIX"
                onMouseLeave={() => setHoverRating(0)}
              >
                {[1, 2, 3, 4, 5].map((star) => {
                  const active = star <= visualRating

                  return (
                    <button
                      key={star}
                      type="button"
                      aria-label={`${star} estrellas`}
                      aria-pressed={rating === star}
                      onMouseEnter={() => setHoverRating(star)}
                      onFocus={() => setHoverRating(star)}
                      onBlur={() => setHoverRating(0)}
                      onClick={() => {
                        setRating(star)
                        setActiveExperience(true)
                        setFeedbackMessage("")
                      }}
                      className={`grid size-7 cursor-pointer place-items-center rounded-md transition-transform duration-150 hover:-translate-y-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#7AB8FF] ${
                        active ? "text-[#0067C9]" : "text-white"
                      }`}
                    >
                      <Star
                        className={`size-4 fill-transparent transition-all duration-150 ${
                          active
                            ? "drop-shadow-[0_0_4px_rgba(0,103,201,0.55)]"
                            : "drop-shadow-none"
                        }`}
                      />
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          {experienceLoaded && activeExperience && !submittedReview && (
            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <input
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
                placeholder="Contanos brevemente tu experiencia"
                className="h-10 min-w-0 flex-1 rounded-lg border border-[#9AA9B8] bg-[#E7EDF3] px-3 text-xs font-semibold text-[#0B1118] outline-none placeholder:text-[#5F6B78] focus:border-[#6EC6FF] focus:ring-2 focus:ring-[#6EC6FF]/35"
              />
              <button
                type="button"
                disabled={submitting || !rating}
                onClick={() => void submitExperience()}
                className="h-10 cursor-pointer rounded-lg border border-[#21476B] bg-[#112A43] px-4 text-xs font-black text-white transition-colors duration-150 hover:border-[#2C6CA3] hover:bg-[#183654] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submitting ? "Enviando..." : "Enviar experiencia"}
              </button>
            </div>
          )}
        </div>
      </div>

      {feedbackMessage && (
        <p className="mt-2 text-xs font-bold text-white/70">
          {feedbackMessage}
        </p>
      )}
    </section>
  )
}
