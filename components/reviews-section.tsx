"use client"

import { useEffect, useState } from "react"
import { Star, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { validatePublicText } from "@/lib/validation/content-filter"

type Review = {
  id: number
  rating: number
  comment: string
  name: string
  province: string
  productName?: string
}

export function ReviewsSection() {
  const [reviews, setReviews] = useState<Review[]>([])
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [approvedBuyer, setApprovedBuyer] = useState<{
    name: string
    province: string
    productName?: string
  } | null>(null)
  const [rating, setRating] = useState(5)
  const [hover, setHover] = useState(0)
  const [comment, setComment] = useState("")

  useEffect(() => {
    const saved = JSON.parse(
      localStorage.getItem("beyonix-reviews") || "[]"
    )
    setReviews(saved)

    const lastOrder = localStorage.getItem("beyonix-last-order")

    if (lastOrder) {
      const parsed = JSON.parse(lastOrder)

      if (parsed.approved && parsed.canReview) {
        setApprovedBuyer({
          name: parsed.customerName || parsed.cliente_nombre || parsed.userName || "Cliente Beyonix",
          province: parsed.province || parsed.provincia || "Argentina",
          productName: parsed.productName || parsed.producto_nombre,
        })
      }
    }
  }, [])

  const handleAddReview = () => {
    if (!approvedBuyer) return
    if (!comment.trim()) return
    if (comment.length > 150) return
    if (rating < 1 || rating > 5) return

    const publicTextError = validatePublicText(comment)
    if (publicTextError) {
      alert(publicTextError)
      return
    }

    const newReview: Review = {
      id: Date.now(),
      rating,
      comment,
      name: approvedBuyer.name,
      province: approvedBuyer.province,
      productName: approvedBuyer.productName,
    }

    const updated = [newReview, ...reviews]

    setReviews(updated)
    localStorage.setItem("beyonix-reviews", JSON.stringify(updated))
    localStorage.setItem(
      "beyonix-last-order",
      JSON.stringify({
        ...approvedBuyer,
        approved: true,
        canReview: false,
      })
    )

    setComment("")
    setRating(5)
    setApprovedBuyer(null)
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
    <div className="bg-card border border-border rounded-lg p-6">
      <div className="flex gap-1 mb-3">
        {Array.from({ length: review.rating }).map((_, i) => (
          <Star
            key={i}
            className="size-4 fill-foreground text-foreground"
          />
        ))}
      </div>

      <p className="text-foreground mb-3 leading-relaxed">
        “{review.comment}”
      </p>

      <p className="text-sm text-muted-foreground">
        Compra verificada
      </p>

      {review.productName && (
        <p className="mt-1 text-sm text-white/60">
          Producto: {review.productName}
        </p>
      )}

      <p className="text-sm font-medium text-foreground mt-2">
        {review.name} · {review.province}
      </p>
    </div>
  )

  return (
    <section className="py-16 lg:py-24 bg-background">
      <div className="container mx-auto px-4 lg:px-8">
        <div className="text-center mb-12 lg:mb-16">
          <p className="text-sm font-medium tracking-widest text-muted-foreground uppercase mb-3">
            Reseñas
          </p>

          <h2 className="text-3xl lg:text-5xl font-bold text-foreground mb-4">
            Opiniones verificadas
          </h2>

          {reviews.length > 0 && (
            <p className="text-sm text-muted-foreground">
              {averageRating}/5 basado en {reviews.length} reseñas verificadas
            </p>
          )}
        </div>

        {approvedBuyer && (
          <div className="max-w-xl mx-auto mb-12 bg-card border border-border rounded-lg p-6 space-y-4">
            <div className="space-y-1">
              <p className="text-sm font-semibold text-foreground">
                Compra verificada
              </p>
              {approvedBuyer.productName && (
                <p className="text-sm text-white/65">
                  Producto: {approvedBuyer.productName}
                </p>
              )}
              <p className="text-sm text-white/65">
                Provincia: {approvedBuyer.province}
              </p>
            </div>

            <div className="flex justify-center gap-1">
              {Array.from({ length: 5 }).map((_, i) => {
                const value = i + 1
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
                          ? "fill-foreground text-foreground"
                          : "text-muted-foreground"
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
              className="resize-none min-h-110px max-h-110px"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />

            <p className="text-xs text-muted-foreground text-right">
              {comment.length}/150
            </p>

            <Button
              type="button"
              aria-label="Enviar reseña"
              title="Enviar reseña"
              onClick={handleAddReview}
              className="w-full"
            >
              Enviar reseña
            </Button>
          </div>
        )}

        {reviews.length === 0 ? (
          <div className="text-center text-muted-foreground">
            Sé el primero en dejar una reseña.
          </div>
        ) : (
          <>
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
              {visibleReviews.map((review) => (
                <ReviewCard key={review.id} review={review} />
              ))}
            </div>

            {reviews.length > 3 && (
              <div className="text-center mt-8">
                <Button
                  type="button"
                  aria-label="Ver todas las reseñas"
                  title="Ver todas las reseñas"
                  variant="outline"
                  onClick={() => setIsModalOpen(true)}
                >
                  Ver todas las reseñas
                </Button>
              </div>
            )}
          </>
        )}

        {isModalOpen && (
          <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4">
            <div className="bg-card border border-border rounded-xl w-full max-w-4xl max-h-80vh overflow-y-auto p-6 relative">
              <Button
                type="button"
                aria-label="Cerrar reseñas"
                title="Cerrar reseñas"
                variant="ghost"
                size="icon"
                className="absolute top-4 right-4"
                onClick={() => setIsModalOpen(false)}
              >
                <X className="size-5" />
              </Button>

              <h3 className="text-2xl font-bold text-foreground mb-6">
                Todas las reseñas
              </h3>

              <div className="grid sm:grid-cols-2 gap-6">
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
