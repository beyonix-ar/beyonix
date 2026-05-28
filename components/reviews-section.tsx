"use client"

import { useEffect, useState } from "react"
import { Star, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"

type Review = {
  id: number
  rating: number
  comment: string
  name: string
  province: string
}

const badWordPatterns = [
  /p[\W_]*u[\W_]*t[\W_]*[oa0@]/i,
  /b[\W_]*o[\W_]*l[\W_]*u[\W_]*d[\W_]*[oa0@]/i,
  /p[\W_]*e[\W_]*l[\W_]*o[\W_]*t[\W_]*u[\W_]*d[\W_]*[oa0@]/i,
  /f[\W_]*o[\W_]*r[\W_]*r[\W_]*[oa0@]/i,
  /m[\W_]*i[\W_]*e[\W_]*r[\W_]*d[\W_]*a/i,
  /i[\W_]*d[\W_]*i[\W_]*o[\W_]*t[\W_]*a/i,
]

export function ReviewsSection() {
  const [reviews, setReviews] = useState<Review[]>([])
  const [isModalOpen, setIsModalOpen] = useState(false)

  const [approvedBuyer, setApprovedBuyer] = useState<{
    name: string
    province: string
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
          name: parsed.name,
          province: parsed.province,
        })
      }
    }
  }, [])

  const hasBadWords = (text: string) => {
    const normalized = text
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")

    return badWordPatterns.some((pattern) =>
      pattern.test(normalized)
    )
  }

  const handleAddReview = () => {
    if (!approvedBuyer) return
    if (!comment.trim()) return
    if (comment.length > 150) return
    if (rating < 1 || rating > 5) return

    if (hasBadWords(comment)) {
      alert("El comentario contiene palabras no permitidas")
      return
    }

    const newReview: Review = {
      id: Date.now(),
      rating,
      comment,
      name: approvedBuyer.name,
      province: approvedBuyer.province,
    }

    const updated = [newReview, ...reviews]

    setReviews(updated)
    localStorage.setItem(
      "beyonix-reviews",
      JSON.stringify(updated)
    )

    setComment("")
    setRating(5)

    // 🔒 evita múltiples reseñas por la misma compra
    localStorage.setItem(
      "beyonix-last-order",
      JSON.stringify({
        ...approvedBuyer,
        approved: true,
        canReview: false,
      })
    )

    setApprovedBuyer(null)
  }

  const visibleReviews = reviews.slice(0, 3)

  const averageRating =
    reviews.length > 0
      ? (
          reviews.reduce((sum, r) => sum + r.rating, 0) /
          reviews.length
        ).toFixed(1)
      : "0.0"

  const ReviewCard = ({ r }: { r: Review }) => (
    <div className="bg-card border border-border rounded-lg p-6">
      <div className="flex gap-1 mb-3">
        {Array.from({ length: r.rating }).map((_, i) => (
          <Star
            key={i}
            className="size-4 fill-foreground text-foreground"
          />
        ))}
      </div>

      <p className="text-foreground mb-3 leading-relaxed">
        "{r.comment}"
      </p>

      <p className="text-sm text-muted-foreground">
        ✔ Compra verificada
      </p>

      <p className="text-sm font-medium text-foreground mt-2">
        — {r.name}, {r.province}
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
              ⭐ {averageRating}/5 basado en {reviews.length} reseñas verificadas
            </p>
          )}
        </div>

        {/* ✅ SOLO APARECE SI COMPRÓ */}
        {approvedBuyer && (
          <div className="max-w-xl mx-auto mb-12 bg-card border border-border rounded-lg p-6 space-y-4">
            <div className="space-y-2">
              <p className="text-sm text-foreground">
                Cliente: {approvedBuyer.name}
              </p>
              <p className="text-sm text-foreground">
                Provincia: {approvedBuyer.province}
              </p>
            </div>

            <div className="flex justify-center gap-1">
              {Array.from({ length: 5 }).map((_, i) => {
                const value = i + 1
                return (
                  <Star
                    key={i}
                    className={`size-6 cursor-pointer transition-all ${
                      value <= (hover || rating)
                        ? "fill-foreground text-foreground"
                        : "text-muted-foreground"
                    }`}
                    onClick={() => setRating(value)}
                    onMouseEnter={() => setHover(value)}
                    onMouseLeave={() => setHover(0)}
                  />
                )
              })}
            </div>

            <Textarea
              placeholder="Comentá tu experiencia (máx 150 caracteres)"
              maxLength={150}
              rows={4}
              className="resize-none min-h-110px max-h-110px"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />

            <p className="text-xs text-muted-foreground text-right">
              {comment.length}/150
            </p>

            <Button onClick={handleAddReview} className="w-full">
              Enviar reseña
            </Button>
          </div>
        )}

        {reviews.length === 0 ? (
          <div className="text-center text-muted-foreground">
            Sé el primero en dejar una reseña ⭐⭐⭐⭐⭐
          </div>
        ) : (
          <>
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
              {visibleReviews.map((r) => (
                <ReviewCard key={r.id} r={r} />
              ))}
            </div>

            {reviews.length > 3 && (
              <div className="text-center mt-8">
                <Button
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
                {reviews.map((r) => (
                  <ReviewCard key={r.id} r={r} />
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}