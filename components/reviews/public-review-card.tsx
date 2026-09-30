import type { ReactNode } from "react"
import { Star } from "lucide-react"

import { formatReviewDate } from "@/lib/reviews/review-format"
import { cn } from "@/lib/utils"

/** Datos públicos de una reseña (ver PublicReview en lib/reviews/server.ts). */
export type PublicReviewView = {
  id: number
  rating: number
  comment: string
  name: string
  city: string
  province: string
  createdAt: string
}

/**
 * Estrellas de una reseña: el valor queda como texto accesible (role="img" +
 * aria-label), no sólo como color. Trazo ámbar oscuro para cumplir 3:1 sobre
 * fondo claro y oscuro.
 */
export function ReviewStars({ rating, className }: { rating: number; className?: string }) {
  const safeRating = Math.max(0, Math.min(5, Math.round(rating)))

  return (
    <div
      role="img"
      aria-label={`${safeRating} de 5 estrellas`}
      className={cn("flex items-center gap-0.5", className)}
    >
      {[1, 2, 3, 4, 5].map((value) => (
        <Star
          key={value}
          aria-hidden="true"
          className={cn(
            "size-4",
            value <= safeRating
              ? "fill-amber-400 text-amber-600"
              : "fill-transparent text-[var(--account-text-muted)]",
          )}
        />
      ))}
    </div>
  )
}

/** "Rosario · Santa Fe" */
export function formatReviewLocation(city: string, province: string) {
  return [city, province].map((part) => part.trim()).filter(Boolean).join(" · ")
}

/**
 * Tarjeta pública de reseña (Home, "Ver todas las reseñas" y reseñas del
 * producto): estrellas, comentario como contenido principal y, debajo, el
 * primer nombre y la ubicación. Sólo tokens de tema: se lee igual en Light y
 * Dark.
 */
export function PublicReviewCard({
  review,
  action,
  className,
}: {
  review: PublicReviewView
  action?: ReactNode
  className?: string
}) {
  const dateLabel = formatReviewDate(review.createdAt)
  const comment = review.comment.trim()
  const location = formatReviewLocation(review.city, review.province)
  const initial = Array.from(review.name.trim())[0]?.toLocaleUpperCase("es-AR") ?? ""

  return (
    <article
      data-public-review
      className={cn(
        "flex h-full min-w-0 flex-col rounded-2xl border border-[var(--account-border)] bg-[var(--account-surface-raised)] p-5 text-[var(--account-text-primary)] shadow-[0_10px_30px_rgba(15,23,42,0.06)]",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <ReviewStars rating={review.rating} />
        <div className="flex items-center gap-2">
          {dateLabel && (
            <time
              dateTime={review.createdAt}
              className="text-xs font-medium text-[var(--account-text-secondary)]"
            >
              {dateLabel}
            </time>
          )}
          {action}
        </div>
      </div>

      {comment ? (
        <blockquote className="mt-3 flex-1 text-[15px] font-medium leading-relaxed text-[var(--account-text-primary)] [overflow-wrap:anywhere]">
          “{comment}”
        </blockquote>
      ) : (
        <p className="mt-3 flex-1 text-sm font-semibold text-[var(--account-text-secondary)]">
          Calificación verificada
        </p>
      )}

      <footer className="mt-4 flex min-w-0 items-center gap-3 border-t border-[var(--account-border-subtle)] pt-3">
        <span
          aria-hidden="true"
          className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[var(--account-accent)] text-sm font-bold text-white"
        >
          {initial}
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-[var(--account-text-primary)]">
            {review.name}
          </p>
          {location && (
            <p className="text-[13px] leading-5 text-[var(--account-text-secondary)] [overflow-wrap:anywhere]">
              {location}
            </p>
          )}
        </div>
      </footer>
    </article>
  )
}
