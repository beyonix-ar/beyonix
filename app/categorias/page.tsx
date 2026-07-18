import Image from "next/image"
import Link from "next/link"
import { ArrowUpRight, Boxes } from "lucide-react"

import {
  getStoreCategorias,
  getStoreProductos,
} from "@/lib/supabase/queries/store"

export const dynamic = "force-dynamic"

function CategoryFallback() {
  return (
    <div className="flex h-full w-full items-center justify-center bg-beyonix-surface-3">
      <div className="flex size-16 items-center justify-center rounded-2xl border border-beyonix-blue-light/20 bg-beyonix-blue/25 text-beyonix-cyan">
        <Boxes className="size-7" />
      </div>
    </div>
  )
}

export default async function CategoriasPage() {
  const [categorias, productos] = await Promise.all([
    getStoreCategorias(),
    getStoreProductos(),
  ])

  const productCountByCategory = productos.reduce<Record<number, number>>(
    (acc, producto) => {
      if (!producto.categoria_id) {
        return acc
      }

      acc[producto.categoria_id] =
        (acc[producto.categoria_id] || 0) + 1

      return acc
    },
    {}
  )

  return (
    <main className="min-h-screen bg-black pt-24 text-white">
      <section className="container mx-auto px-4 pb-16 pt-12 lg:px-8 lg:pt-16">
        <div className="mb-10 max-w-3xl">
          <p className="mb-2 text-11px font-semibold uppercase tracking-widest text-beyonix-cyan">
            Categorias
          </p>

          <h1 className="text-4xl font-bold tracking-tight lg:text-6xl">
            Explorá la tienda por categoría
          </h1>

          <p className="mt-4 text-base leading-7 text-white/62 lg:text-lg">
            Explorá nuestras líneas de productos y encontrá rápidamente lo que estás buscando.
          </p>
        </div>

        {categorias.length ? (
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
            {categorias.map((categoria) => {
              const count =
                productCountByCategory[categoria.id] || 0

              return (
                <Link
                  key={categoria.id}
                  href={`/categorias/${categoria.slug}`}
                  className="group cursor-pointer overflow-hidden rounded-2xl border border-white/8 bg-beyonix-surface shadow-xl shadow-black/20 transition-all duration-300 hover:-translate-y-1 hover:border-beyonix-blue-light/35 hover:shadow-black/45"
                >
                  <div className="relative aspect-category-featured overflow-hidden bg-beyonix-surface-3">
                    {categoria.imagen ? (
                      <Image
                        fill
                        src={categoria.imagen}
                        alt={categoria.nombre}
                        sizes="(min-width: 1280px) 33vw, (min-width: 768px) 50vw, 100vw"
                        className="object-contain object-center"
                      />
                    ) : (
                      <CategoryFallback />
                    )}

                    <div className="absolute inset-0 bg-linear-to-t from-black/86 via-black/28 to-transparent" />
                    <div className="absolute inset-x-0 bottom-0 p-5">
                      <div className="mb-3 flex items-center justify-between gap-4">
                        <div className="min-w-0">
                          <h2 className="truncate text-2xl font-semibold text-white">
                            {categoria.nombre}
                          </h2>
                          <p className="mt-1 text-12px font-semibold uppercase tracking-widest text-beyonix-cyan/75">
                            {count} producto{count === 1 ? "" : "s"}
                          </p>
                        </div>

                        <span className="flex size-10 shrink-0 items-center justify-center rounded-full border border-white/14 bg-black/45 text-beyonix-cyan transition-all group-hover:border-beyonix-blue-light/45 group-hover:bg-beyonix-blue/60">
                          <ArrowUpRight className="size-4" />
                        </span>
                      </div>

                      <p className="line-clamp-2 min-h-40px text-sm leading-5 text-white/62">
                        {categoria.descripcion || "Explorá esta categoría y sus productos disponibles."}
                      </p>
                    </div>
                  </div>
                </Link>
              )
            })}
          </div>
        ) : (
          <div className="rounded-3xl border border-white/8 bg-beyonix-surface px-6 py-14 text-center">
            <Boxes className="mx-auto mb-4 size-10 text-beyonix-cyan/45" />
            <p className="text-sm text-white/58">
              Todavia no hay categorias cargadas.
            </p>
          </div>
        )}
      </section>
    </main>
  )
}
