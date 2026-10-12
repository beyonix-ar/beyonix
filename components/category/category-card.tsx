import Image from "next/image"
import Link from "next/link"
import { ArrowUpRight, Boxes } from "lucide-react"

import type { SupabaseCategoria } from "@/lib/supabase/types"

function CategoryFallback() {
  return (
    <div className="flex h-full w-full items-start justify-center bg-beyonix-surface-3 pt-5">
      <div className="flex size-12 items-center justify-center rounded-2xl border border-beyonix-blue-light/20 bg-beyonix-blue/25 text-beyonix-cyan">
        <Boxes className="size-6" />
      </div>
    </div>
  )
}

/**
 * Card de categoría (Home y /categorias). El banner ya trae el nombre
 * incorporado: se muestra completo, sin texto duplicado ni cantidad de
 * productos; el nombre queda como nombre accesible del enlace y de la imagen.
 */
export function CategoryCard({
  categoria,
  fallbackDescription,
}: {
  categoria: Pick<SupabaseCategoria, "slug" | "nombre" | "imagen" | "descripcion">
  /** Texto cuando la categoría no tiene descripción cargada. */
  fallbackDescription: string
}) {
  return (
    <Link
      href={`/categorias/${categoria.slug}`}
      aria-label={categoria.nombre}
      className="group cursor-pointer overflow-hidden rounded-2xl border border-white/8 bg-beyonix-surface shadow-xl shadow-black/20 transition-all duration-300 hover:-translate-y-1 hover:border-beyonix-blue-light/35 hover:shadow-black/45"
    >
      <div className="relative aspect-[48/13] overflow-hidden bg-[#06182B]">
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

      </div>
      <div className="flex items-center justify-between gap-4 bg-[#0A0A0A] p-5">
        <p className="line-clamp-2 min-w-0 text-sm leading-5 text-white">
          {categoria.descripcion || fallbackDescription}
        </p>

        <span className="flex size-10 shrink-0 items-center justify-center rounded-full border border-white/14 bg-black/45 text-[#8CC8F2] transition-all group-hover:border-beyonix-blue-light/45 group-hover:bg-beyonix-blue/60">
          <ArrowUpRight className="size-4" />
        </span>
      </div>
    </Link>
  )
}
