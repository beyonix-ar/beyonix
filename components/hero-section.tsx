"use client"

import Image from "next/image"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { ArrowRight } from "lucide-react"
import { GlobalSearchBar } from "@/components/global-search-bar"

export function HeroSection() {
  const [search, setSearch] = useState("")

  const scrollToProducts = () => {
    document.getElementById("productos")?.scrollIntoView({
      behavior: "smooth",
    })
  }

  const scrollToCategories = () => {
    document.getElementById("categorias")?.scrollIntoView({
      behavior: "smooth",
    })
  }

  return (
    <section className="relative min-h-[90vh] flex items-center overflow-hidden pt-20">
      {/* Background Image */}
      <div className="absolute inset-0 z-0">
        <Image
          src="/images/hero-bg.jpg"
          alt="BEYONIX - Tecnología para tu comodidad"
          fill
          className="object-cover"
          priority
        />
        <div className="absolute inset-0 bg-linear-to-r from-background via-background/60 to-transparent" />
      </div>

      {/* Global Search over image */}
      <div className="global-search-wrapper absolute top-24 left-0 right-0 z-20">
        <GlobalSearchBar
          search={search}
          onSearchChange={setSearch}
        />
      </div>

      {/* Content */}
      <div className="relative z-10 container mx-auto px-6 lg:px-12 pt-8">
        <div className="max-w-2xl">
          <div className="inline-block mb-6">
            <span className="text-xs lg:text-sm font-semibold tracking-[0.2em] text-white/65 uppercase border border-border/90 px-4 py-2 rounded-full">
              Tecnología Premium
            </span>
          </div>

          <h1 className="text-2xl sm:text-3xl lg:text-4xl xl:text-5xl font-bold tracking-tight text-foreground mb-6 text-balance leading-1.1">
            Tecnología pensada para tu comodidad
          </h1>

          <p className="text-base lg:text-lg text-white/65 max-w-lg mb-10 leading-relaxed">
            Descubrí productos premium que transforman tu espacio y mejoran tu día a día.
            Tecnología inteligente para una vida más cómoda.
          </p>

          <div className="flex flex-col sm:flex-row items-start gap-4">
            <Button
              variant="outline"
              size="lg"
              className="px-8 h-14 text-base font-medium border-foreground/20 hover:bg-foreground/10"
              onClick={scrollToProducts}
            >
              Explorar Tienda

            </Button>

            <Button
              variant="outline"
              size="lg"
              className="px-8 h-14 text-base font-medium border-foreground/20 hover:bg-foreground/10"
              onClick={scrollToCategories}
            >
              Ver Categorías

            </Button>
          </div>

          {/* Trust badges */}
          <div className="mt-12 pt-8">
            <div className="mb-8 h-px w-640px bg-white" />

            <div className="flex items-center gap-6">
              <div className="flex flex-col">
                <span className="text-[18px] font-bold text-foreground">
                  Productos destacados
                </span>
                <span className="text-[14px] text-white/65">
                  Selección exclusiva
                </span>
              </div>

              <div className="w-px h-10 hero-divider" />

              <div className="flex flex-col">
                <span className="text-[18px] font-bold text-foreground">
                  Tecnología útil
                </span>
                <span className="text-[14px] text-white/65">
                  Para tu día a día
                </span>
              </div>

              <div className="w-px h-10 hero-divider" />

              <div className="flex flex-col">
                <span className="text-[18px] font-bold text-foreground">
                  Innovación constante
                </span>
                <span className="text-[14px] text-white/65">
                  Lo último en tendencia
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}