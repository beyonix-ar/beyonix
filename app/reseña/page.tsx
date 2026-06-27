import { Star } from "lucide-react"

export function ReviewsSection() {
  return (
    <section className="py-16 lg:py-24 bg-background">
      <div className="container mx-auto px-4 lg:px-8">
        
        {/* Header */}
        <div className="text-center mb-12 lg:mb-16">
          <p className="text-sm font-medium tracking-widest text-muted-foreground uppercase mb-3">
            Reseñas
          </p>

          <h2 className="text-3xl lg:text-5xl font-bold tracking-tight text-foreground mb-4">
            Opiniones verificadas
          </h2>

          <p className="text-muted-foreground max-w-2xl mx-auto">
            Solo clientes que realizaron una compra pueden dejar su opinión sobre Beyonix
          </p>
        </div>

        {/* Placeholder */}
        <div className="max-w-xl mx-auto">
          <div className="bg-card border border-border rounded-lg p-8 text-center">

            {/* Stars (visual) */}
            <div className="flex justify-center gap-1 mb-4 opacity-40">
              {Array.from({ length: 5 }).map((_, i) => (
                <Star key={i} className="size-5" />
              ))}
            </div>

            <p className="text-foreground mb-2 font-medium">
              Todavía no hay reseñas
            </p>

            <p className="text-sm text-muted-foreground">
              Sé el primero en comprar y compartir tu experiencia con Beyonix
            </p>

          </div>
        </div>

      </div>
    </section>
  )
}

export default ReviewsSection
