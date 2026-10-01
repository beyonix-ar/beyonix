"use client"

import { useCallback, useEffect, useState } from "react"
import { Check, MessageSquareText, Star } from "lucide-react"

import { supabase } from "@/lib/supabase/client"
import { formatPublicOrderId } from "@/lib/account/account-formatters"
import { formatReviewDate } from "@/lib/reviews/review-format"
import { cn } from "@/lib/utils"
import {
  adminPageClassName,
  AdminBadge,
  AdminCard,
  AdminEmptyState,
  AdminInfoBlock,
  AdminPageHeader,
  AdminPagination,
  AdminPrimaryButton,
  AdminSecondaryButton,
  AdminSkeleton,
} from "../../components/admin-controls"

type AdminReview = {
  id: number
  orderId: number
  productId: number | null
  productName: string | null
  rating: number
  comment: string
  nickname: string
  city: string
  province: string
  approved: boolean
  featured: boolean
  featuredAt: string | null
  createdAt: string
}

type AdminReviewFilter = "all" | "experiences" | "featured" | "not_featured"

const FILTERS: Array<{ value: AdminReviewFilter; label: string }> = [
  { value: "all", label: "Todas" },
  { value: "experiences", label: "Experiencias" },
  { value: "featured", label: "Destacadas en Home" },
  { value: "not_featured", label: "No destacadas" },
]

type AdminReviewStatus = "pending" | "approved" | "featured_home" | "featured_product"

/**
 * Estado visible para el Admin. Home muestra SOLO experiencias aprobadas y
 * destacadas; una reseña de producto destacada de antes nunca llega a Home.
 */
function getAdminReviewStatus(review: AdminReview): AdminReviewStatus {
  if (!review.approved) return "pending"
  if (!review.featured) return "approved"
  return review.productId == null ? "featured_home" : "featured_product"
}

const STATUS_BADGES: Record<AdminReviewStatus, { label: string; tone: "warning" | "info" | "success" }> = {
  pending: { label: "Pendiente", tone: "warning" },
  approved: { label: "Aprobada", tone: "info" },
  featured_home: { label: "Destacada en Home", tone: "success" },
  featured_product: { label: "Destacada · no se muestra en Home", tone: "warning" },
}

async function getAuthHeaders(): Promise<Record<string, string> | null> {
  const {
    data: { session },
  } = await supabase.auth.getSession()

  return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : null
}

function ReviewStars({ rating }: { rating: number }) {
  return (
    <div className="flex gap-0.5" role="img" aria-label={`${rating} de 5 estrellas`}>
      {[1, 2, 3, 4, 5].map((value) => (
        <Star
          key={value}
          className={cn(
            "size-3.5",
            value <= rating ? "fill-amber-300 text-amber-300" : "text-white/25",
          )}
        />
      ))}
    </div>
  )
}

export function AdminResenas() {
  const [reviews, setReviews] = useState<AdminReview[]>([])
  const [filter, setFilter] = useState<AdminReviewFilter>("all")
  const [page, setPage] = useState(1)
  const [pageCount, setPageCount] = useState(1)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [updatingId, setUpdatingId] = useState<number | null>(null)
  const [error, setError] = useState("")
  const [message, setMessage] = useState("")

  const loadReviews = useCallback(async () => {
    setLoading(true)
    setError("")

    try {
      const headers = await getAuthHeaders()
      if (!headers) {
        setError("No se pudo validar la sesión.")
        return
      }

      const response = await fetch(`/api/admin/reviews?filter=${filter}&page=${page}`, {
        headers,
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      })
      const data = (await response.json()) as {
        reviews?: AdminReview[]
        pageCount?: number
        total?: number
        error?: string
      }

      if (!response.ok) {
        setError(data.error ?? "No se pudieron cargar las reseñas.")
        return
      }

      setReviews(data.reviews ?? [])
      setPageCount(data.pageCount ?? 1)
      setTotal(data.total ?? 0)
    } catch {
      setError("No se pudieron cargar las reseñas.")
    } finally {
      setLoading(false)
    }
  }, [filter, page])

  useEffect(() => {
    void loadReviews()
  }, [loadReviews])

  const setFeatured = async (review: AdminReview, featured: boolean) => {
    if (updatingId !== null) return

    setUpdatingId(review.id)
    setError("")
    setMessage("")

    try {
      const headers = await getAuthHeaders()
      if (!headers) {
        setError("No se pudo validar la sesión.")
        return
      }

      const response = await fetch("/api/admin/reviews", {
        method: "PATCH",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ id: review.id, featured }),
        signal: AbortSignal.timeout(15_000),
      })
      const data = (await response.json()) as {
        review?: { featured: boolean; featuredAt: string | null }
        error?: string
      }

      if (!response.ok || !data.review) {
        setError(data.error ?? "No se pudo actualizar la reseña.")
        return
      }

      const updated = data.review
      setReviews((current) =>
        filter === "all" || filter === "experiences"
          ? current.map((item) =>
              item.id === review.id
                ? { ...item, featured: updated.featured, featuredAt: updated.featuredAt }
                : item,
            )
          : current.filter((item) => item.id !== review.id),
      )
      setMessage(featured ? "Reseña destacada en Home." : "Reseña quitada de Home.")
    } catch {
      setError("No se pudo actualizar la reseña.")
    } finally {
      setUpdatingId(null)
    }
  }

  return (
    <div className={adminPageClassName}>
      <AdminPageHeader
        eyebrow="Clientes"
        title="Reseñas"
        description="Home muestra solo experiencias de compra aprobadas y destacadas. Las reseñas de producto se ven en la ficha de cada producto."
      />

      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filtrar reseñas">
        {FILTERS.map((option) => {
          const Button = option.value === filter ? AdminPrimaryButton : AdminSecondaryButton
          return (
            <Button
              key={option.value}
              size="sm"
              aria-pressed={option.value === filter}
              onClick={() => {
                setFilter(option.value)
                setPage(1)
                setMessage("")
              }}
            >
              {option.label}
            </Button>
          )
        })}
        {!loading && (
          <span className="ml-auto text-xs font-semibold text-white/58">
            {total} {total === 1 ? "reseña" : "reseñas"}
          </span>
        )}
      </div>

      {error ? <AdminInfoBlock tone="danger">{error}</AdminInfoBlock> : null}
      {message ? <AdminInfoBlock tone="success">{message}</AdminInfoBlock> : null}

      {loading ? (
        <AdminSkeleton rows={4} />
      ) : reviews.length === 0 ? (
        <AdminEmptyState
          icon={<MessageSquareText className="size-5" />}
          title="No hay reseñas para mostrar"
          description={
            filter === "featured"
              ? "Todavía no destacaste ninguna reseña. Home no muestra reseñas hasta que destaques alguna."
              : "Las reseñas de tus clientes aparecerán acá."
          }
        />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {reviews.map((review) => {
            const dateLabel = formatReviewDate(review.createdAt)
            const hasComment = review.comment.trim().length > 0
            const isProductReview = review.productId != null
            const canFeature = review.approved && hasComment
            const status = getAdminReviewStatus(review)
            const statusBadge = STATUS_BADGES[status]

            return (
              <AdminCard key={review.id} className="flex flex-col gap-3" data-review-status={status}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <ReviewStars rating={review.rating} />
                  <div className="flex flex-wrap gap-1.5">
                    <AdminBadge tone={isProductReview ? "info" : "neutral"}>
                      {isProductReview ? "Reseña de producto" : "Experiencia"}
                    </AdminBadge>
                    <AdminBadge tone={statusBadge.tone} data-review-status-badge="">
                      {status === "featured_home" ? <Check className="size-3" /> : null}
                      {statusBadge.label}
                    </AdminBadge>
                  </div>
                </div>

                {status === "approved" && !isProductReview ? (
                  <p data-review-home-hint className="text-xs font-semibold text-amber-200">
                    Aprobada. No aparece en Home hasta que la destaques.
                  </p>
                ) : status === "pending" ? (
                  <p className="text-xs font-semibold text-amber-200">
                    Pendiente de publicación: no se muestra en la tienda.
                  </p>
                ) : null}

                {review.productId && (
                  <p className="truncate text-xs font-semibold text-white/66">
                    {review.productName ?? `Producto #${review.productId}`}
                  </p>
                )}

                {hasComment ? (
                  <p className="text-sm leading-6 text-white">“{review.comment}”</p>
                ) : (
                  <p className="text-sm italic text-white/58">Sin comentario</p>
                )}

                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-semibold text-white/66">
                  <span>
                    {review.nickname} · {review.city}, {review.province}
                  </span>
                  {dateLabel && <span>{dateLabel}</span>}
                  <span>Pedido {formatPublicOrderId(review.orderId)}</span>
                </div>

                <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
                  {/* El Home sólo muestra experiencias: una reseña de producto
                      no ofrece "Destacar en Home" (la API y la base también lo
                      rechazan). Si alguna quedó destacada de antes, sólo se
                      permite quitarla. */}
                  {isProductReview && !review.featured ? (
                    <p data-product-review-note className="text-xs font-medium text-white/66">
                      Las reseñas de producto se muestran en la ficha del producto, no en Home.
                    </p>
                  ) : review.featured ? (
                    <AdminSecondaryButton
                      size="sm"
                      aria-label={`Quitar de Home la reseña de ${review.nickname}`}
                      disabled={updatingId !== null}
                      onClick={() => void setFeatured(review, false)}
                    >
                      {updatingId === review.id ? "Guardando…" : "Quitar de Home"}
                    </AdminSecondaryButton>
                  ) : (
                    <AdminPrimaryButton
                      size="sm"
                      aria-label={`Destacar en Home la reseña de ${review.nickname}`}
                      title={canFeature ? undefined : "Solo se pueden destacar reseñas publicadas con comentario."}
                      disabled={updatingId !== null || !canFeature}
                      onClick={() => void setFeatured(review, true)}
                    >
                      {updatingId === review.id ? "Guardando…" : "Destacar en Home"}
                    </AdminPrimaryButton>
                  )}
                </div>
              </AdminCard>
            )
          })}
        </div>
      )}

      {!loading && pageCount > 1 && (
        <AdminPagination page={page} pageCount={pageCount} onPageChange={setPage} />
      )}
    </div>
  )
}
