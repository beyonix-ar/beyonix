"use client"

import Image from "next/image"
import Link from "next/link"
import { ArrowRight, ArrowUpRight, Boxes } from "lucide-react"

import {
  BeyonixButton,
  BeyonixCard,
  BeyonixIconBox,
  BeyonixSectionHeader,
} from "@/components/beyonix-ui"
import { useStore } from "@/hooks/use-store"

function CategoryFallback() {
  return (
    <div className="flex h-full w-full items-center justify-center bg-beyonix-surface-3">
      <BeyonixIconBox size="lg" className="text-beyonix-sky">
        <Boxes className="size-7" />
      </BeyonixIconBox>
    </div>
  )
}

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
            <BeyonixCard
              asChild
              key={categoria.id}
              variant="interactive"
              className="group relative cursor-pointer overflow-hidden text-left transition-transform duration-200 hover:-translate-y-0.5"
            >
              <Link href={`/categorias/${categoria.slug}`}>
                <div className="relative aspect-category-featured overflow-hidden bg-beyonix-surface-3">
                  {categoria.imagen ? (
                    <Image
                      fill
                      alt={categoria.nombre}
                      src={categoria.imagen}
                      sizes="(min-width: 1280px) 33vw, (min-width: 768px) 50vw, 100vw"
                      className="object-contain object-center"
                    />
                  ) : (
                    <CategoryFallback />
                  )}

                  <div className="absolute inset-0 bg-linear-to-t from-black/92 via-black/36 to-black/10" />
                  <div className="absolute inset-x-0 bottom-0 p-5">
                    <div className="mb-3 flex items-center justify-between gap-4">
                      <h3 className="line-clamp-2 text-2xl font-semibold tracking-tight text-white">
                        {categoria.nombre}
                      </h3>

                      <BeyonixIconBox
                        size="md"
                        className="rounded-full text-beyonix-sky opacity-84 group-hover:border-beyonix-blue-light/58 group-hover:text-white"
                      >
                        <ArrowUpRight className="size-4" />
                      </BeyonixIconBox>
                    </div>

                    <p className="line-clamp-2 min-h-40px text-sm leading-5 text-white/64">
                      {categoria.descripcion ||
                        "Explorá productos seleccionados para esta categoría."}
                    </p>
                  </div>
                </div>
              </Link>
            </BeyonixCard>
          ))}
        </div>
      </div>
    </section>
  )
}
