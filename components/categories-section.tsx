"use client"

import Image from "next/image"
import Link from "next/link"
import { ArrowRight, ArrowUpRight, Boxes } from "lucide-react"

import { useStore } from "@/hooks/use-store"

function CategoryFallback() {
  return (
    <div className="flex h-full w-full items-center justify-center bg-beyonix-surface-3">
      <div className="flex size-16 items-center justify-center rounded-2xl border border-beyonix-blue-light/20 bg-beyonix-blue/25 text-beyonix-cyan">
        <Boxes className="size-7" />
      </div>
    </div>
  )
}

function getFeaturedPosition(
  position?: number | null
) {
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
    featuredCategories.length > 0
      ? featuredCategories
      : categorias.slice(0, 3)

  if (!visibleCategories.length) {
    return null
  }

  return (
    <section
      id="categorias"
      className="scroll-mt-24 py-16 lg:py-24"
    >
      <div className="container mx-auto px-4 lg:px-8">
        <div className="mb-10 flex flex-col gap-4 lg:mb-14 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="mb-2 text-11px font-semibold uppercase tracking-widest text-beyonix-cyan">
              Categorias
            </p>

            <h2 className="max-w-2xl text-3xl font-bold tracking-tight text-white lg:text-5xl">
              Exploración rápida por categoría
            </h2>

            <p className="mt-3 max-w-xl text-sm leading-6 text-white/58">
              Elegí la categoría que más va con vos y encontrá productos pensados para tu día a día.
            </p>
          </div>

          <Link
            href="/categorias"
            className="inline-flex h-11 cursor-pointer items-center gap-2 self-start rounded-xl border border-white/12 px-5 text-sm font-medium text-white/72 transition-colors hover:border-beyonix-blue-light/35 hover:text-white lg:self-auto"
          >
            Ver todas
            <ArrowRight className="size-3.5" />
          </Link>
        </div>

        <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
          {visibleCategories.map((categoria, index) => (
            <Link
              key={categoria.id}
              href={`/categorias/${categoria.slug}`}
              className={`group relative cursor-pointer overflow-hidden rounded-2xl border border-white/8 bg-beyonix-surface text-left shadow-xl shadow-black/20 transition-all duration-300 hover:-translate-y-1 hover:border-beyonix-blue-light/35 hover:shadow-black/45 ${
                index === 0 ? "md:col-span-2 xl:col-span-1" : ""
              }`}
            >
              <div className="relative aspect-category-featured overflow-hidden bg-beyonix-surface-3">
                {categoria.imagen ? (
                  <Image
                    fill
                    alt={categoria.nombre}
                    src={categoria.imagen}
                    sizes="(min-width: 1280px) 33vw, (min-width: 768px) 50vw, 100vw"
                    className="object-cover transition-transform duration-500 group-hover:scale-105"
                  />
                ) : (
                  <CategoryFallback />
                )}

                <div className="absolute inset-0 bg-linear-to-t from-black/90 via-black/28 to-black/5" />
                <div className="absolute inset-x-0 bottom-0 p-5">
                  <div className="mb-3 flex items-center justify-between gap-4">
                    <h3 className="line-clamp-2 text-2xl font-semibold tracking-tight text-white">
                      {categoria.nombre}
                    </h3>

                    <span className="flex size-10 shrink-0 items-center justify-center rounded-full border border-white/14 bg-black/45 text-beyonix-cyan opacity-80 transition-all group-hover:border-beyonix-blue-light/45 group-hover:bg-beyonix-blue/60 group-hover:opacity-100">
                      <ArrowUpRight className="size-4" />
                    </span>
                  </div>

                  <p className="line-clamp-2 min-h-40px text-sm leading-5 text-white/62">
                    {categoria.descripcion || "Explorá productos seleccionados para esta categoría."}
                  </p>
                </div>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </section>
  )
}
