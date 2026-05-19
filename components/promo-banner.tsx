"use client"

import { Button } from "@/components/ui/button"
import { ArrowRight, Percent } from "lucide-react"

export function PromoBanner() {
  const scrollToProducts = () => {
    document.getElementById("productos")?.scrollIntoView({ behavior: "smooth" })
  }

  return (
    <section className="py-16 lg:py-24 bg-primary text-primary-foreground">
      <div className="container mx-auto px-4 lg:px-8">
        <div className="flex flex-col lg:flex-row items-center justify-between gap-8 lg:gap-12">
          <div className="text-center lg:text-left">
            <div className="inline-flex items-center gap-2 px-4 py-2 bg-primary-foreground/10 rounded-full mb-6">
              <Percent className="size-4" />
              <span className="text-sm font-medium">Ofertas semanales</span>
            </div>
            
            <h2 className="text-3xl lg:text-5xl font-bold tracking-tight mb-4 text-balance">
              Hasta 40% OFF en productos seleccionados
            </h2>
            
            <p className="text-lg text-primary-foreground/80 max-w-xl mb-8">
              Aprovechá nuestras ofertas exclusivas. Stock limitado en auriculares, 
              iluminación LED y accesorios premium.
            </p>

            <Button
              size="lg"
              variant="secondary"
              className="bg-primary-foreground text-primary hover:bg-primary-foreground/90"
              onClick={scrollToProducts}
            >
              Ver todas las ofertas
              <ArrowRight className="ml-2 size-4" />
            </Button>
          </div>

          <div className="flex items-center gap-6 lg:gap-8">
            <div className="text-center">
              <div className="text-5xl lg:text-7xl font-bold">40</div>
              <div className="text-sm lg:text-base text-primary-foreground/80">% OFF</div>
            </div>
            <div className="w-px h-20 bg-primary-foreground/20" />
            <div className="text-center">
              <div className="text-5xl lg:text-7xl font-bold">3</div>
              <div className="text-sm lg:text-base text-primary-foreground/80">Cuotas sin interés</div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
