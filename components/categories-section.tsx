"use client"

import Link from "next/link"
import { ArrowRight } from "lucide-react"

import { BeyonixButton, BeyonixSectionHeader } from "@/components/beyonix-ui"
import { CategoryCard } from "@/components/category/category-card"
import { useStore } from "@/hooks/use-store"

function getFeaturedPosition(position?: number | null) {
  return position ?? 99
}

export function CategoriesSection() {
  const { categorias } = useStore()
  const featuredCategories = categorias
    .filter((categoria) => categoria.destacado === true)
    .sort(
      (a, b) =>
        getFeaturedPosition(a.posicion_destacada) -
          getFeaturedPosition(b.posicion_destacada) ||
        a.nombre.localeCompare(b.nombre)
    )
    .slice(0, 3)

  const visibleCategories =
    featuredCategories.length > 0 ? featuredCategories : categorias.slice(0, 3)

  if (!visibleCategories.length) {
    return null
  }

  return (
    <section id="categorias" className="scroll-mt-24 beyonix-section-spacing">
      <div className="container mx-auto px-4 lg:px-8">
        <BeyonixSectionHeader
          eyebrow="Categorías"
          title="Exploración rápida por categoría"
          description="Elegí la categoría que más va con vos y encontrá productos pensados para tu día a día."
          action={
            <BeyonixButton asChild variant="outline">
              <Link href="/categorias">
                Ver todas
                <ArrowRight className="size-3.5" />
              </Link>
            </BeyonixButton>
          }
        />

        <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
          {visibleCategories.map((categoria) => (
            <CategoryCard
              key={categoria.id}
              categoria={categoria}
              fallbackDescription="Explorá productos seleccionados para esta categoría."
            />
          ))}
        </div>
      </div>
    </section>
  )
}
