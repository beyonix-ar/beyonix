import Image from "next/image"
import Link from "next/link"
import { ArrowUpRight, Boxes } from "lucide-react"

import { getStoreCategorias } from "@/lib/supabase/queries/store"

export const dynamic = "force-dynamic"

function CategoryFallback() {
  return (
    <div className="flex h-full w-full items-start justify-center bg-beyonix-surface-3 pt-5">
      <div className="flex size-12 items-center justify-center rounded-2xl border border-beyonix-blue-light/20 bg-beyonix-blue/25 text-beyonix-cyan">
        <Boxes className="size-6" />
      </div>
    </div>
  )
}

export default async function CategoriasPage() {
  const categorias = await getStoreCategorias()

  return (
    <main className="beyonix-categories-page-bg min-h-screen bg-black pt-24 text-white">
      <section className="container mx-auto px-4 pb-16 pt-12 lg:px-8 lg:pt-16">
        <div className="mb-10 max-w-3xl">
          <p className="mb-2 text-11px font-semibold uppercase tracking-widest text-beyonix-cyan">
            Categorias
          </p>

          <h1 className="beyonix-modal-title text-4xl font-bold tracking-tight lg:text-6xl">
            Explorá la tienda por categoría
          </h1>

          <p className="beyonix-modal-body mt-4 text-base leading-7 text-white/62 lg:text-lg">
            Explorá nuestras líneas de productos y encontrá rápidamente lo que estás buscando.
          </p>
        </div>

        {categorias.length ? (
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
            {categorias.map((categoria) => {
              return (
                <Link
                  key={categoria.id}
                  href={`/categorias/${categoria.slug}`}
                  aria-label={categoria.nombre}
                  className="group cursor-pointer overflow-hidden rounded-2xl border border-white/8 bg-beyonix-surface shadow-xl shadow-black/20 transition-all duration-300 hover:-translate-y-1 hover:border-beyonix-blue-light/35 hover:shadow-black/45"
                >
                  {/* Misma proporción que el banner cargado en Admin (1568 x 600): cubre sin franjas ni recortes. */}
                  <div className="relative aspect-[1568/600] overflow-hidden bg-beyonix-surface-3">
                    {categoria.imagen ? (
                      <Image
                        fill
                        src={categoria.imagen}
                        alt={categoria.nombre}
                        sizes="(min-width: 1280px) 33vw, (min-width: 768px) 50vw, 100vw"
                        className="object-cover object-center"
                      />
                    ) : (
                      <CategoryFallback />
                    )}

                    {/* El banner ya trae el nombre: sólo la descripción y el acceso. */}
                    <div className="absolute inset-0 bg-linear-to-t from-black/86 via-black/20 to-transparent" />
                    <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-4 p-5">
                      <p className="line-clamp-2 min-w-0 text-sm leading-5 text-white/62">
                        {categoria.descripcion || "Explorá esta categoría y sus productos disponibles."}
                      </p>

                      <span className="flex size-10 shrink-0 items-center justify-center rounded-full border border-white/14 bg-black/45 text-[#8CC8F2] transition-all group-hover:border-beyonix-blue-light/45 group-hover:bg-beyonix-blue/60">
                        <ArrowUpRight className="size-4" />
                      </span>
                    </div>
                  </div>
                </Link>
              )
            })}
          </div>
        ) : (
          <div className="rounded-3xl border border-white/8 bg-beyonix-surface px-6 py-14 text-center">
            <Boxes className="mx-auto mb-4 size-10 text-beyonix-cyan/45" />
            <p className="beyonix-modal-muted text-sm text-white/58">
              Todavia no hay categorias cargadas.
            </p>
          </div>
        )}
      </section>
    </main>
  )
}
