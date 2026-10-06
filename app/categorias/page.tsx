import { Boxes } from "lucide-react"

import { CategoryCard } from "@/components/category/category-card"
import { getStoreCategorias } from "@/lib/supabase/queries/store"

export const dynamic = "force-dynamic"

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
            {categorias.map((categoria) => (
              <CategoryCard
                key={categoria.id}
                categoria={categoria}
                fallbackDescription="Explorá esta categoría y sus productos disponibles."
              />
            ))}
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
