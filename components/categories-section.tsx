"use client"

import Image from "next/image"

import {
  ArrowUpRight,
} from "lucide-react"

import { useRouter } from "next/navigation"

import { useStore } from "@/hooks/use-store"

export function CategoriesSection() {
  const router = useRouter()

  const { categorias } =
    useStore()

  const featured =
    categorias.slice(0, 3)

  if (!featured.length) {
    return null
  }

  return (
    <section
      id="categorias"
      className="scroll-mt-24 bg-background py-16 lg:py-24"
    >
      <div className="container mx-auto px-4 lg:px-8">
        <div className="mb-16 text-center lg:mb-24">
          <p className="mb-3 text-sm font-medium uppercase tracking-widest text-muted-foreground">
            Categorías
          </p>

          <h2 className="text-balance text-3xl font-bold tracking-tight text-foreground lg:text-5xl">
            Explorá nuestras
            categorías
          </h2>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3 lg:gap-6">
          {featured.map(
            (
              categoria,
              index
            ) => (
              <button
                key={
                  categoria.id
                }
                type="button"
                title={
                  categoria.nombre
                }
                aria-label={
                  categoria.nombre
                }
                onClick={() =>
                  router.push(
                    `/categorias/${categoria.slug}`
                  )
                }
                className={`group relative overflow-hidden rounded-3xl border border-border bg-card text-left transition-all duration-500 hover:-translate-y-1 ${
                  index === 0
                    ? "aspect-[16/9.2] lg:col-span-2"
                    : "aspect-video"
                }`}
              >
                <div className="absolute inset-0">
                  <Image
                    fill
                    alt={
                      categoria.nombre
                    }
                    src={
                      categoria.imagen ||
                      "/placeholder.png"
                    }
                    className={`object-cover transition-transform duration-500 ${
                      index === 0
                        ? "group-hover:scale-105"
                        : "group-hover:scale-100"
                    }`}
                  />
                </div>

                <div className="absolute inset-0 bg-linear-to-t from-black/85 via-black/20 to-transparent" />

                <div className="absolute inset-0 flex flex-col justify-end px-6 pb-6">
                  <div className="flex items-end justify-between gap-4">
                    <div>
                      <h3
                        className={`mb-1 font-semibold text-foreground ${
                          index === 0
                            ? "text-2xl lg:text-3xl"
                            : "text-base lg:text-lg"
                        }`}
                      >
                        {
                          categoria.nombre
                        }
                      </h3>

                      <p className="text-sm text-muted-foreground">
                        {categoria.descripcion ||
                          "Explorar categoría"}
                      </p>
                    </div>

                    <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground opacity-0 transition-opacity group-hover:opacity-100">
                      <ArrowUpRight className="size-5" />
                    </div>
                  </div>
                </div>
              </button>
            )
          )}
        </div>
      </div>
    </section>
  )
}