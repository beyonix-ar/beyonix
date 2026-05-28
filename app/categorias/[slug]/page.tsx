import { notFound } from "next/navigation"

import { CategoryPageLayout } from "@/components/category/layout/category-page-layout"

import {
  getCategoriaBySlug,
} from "@/lib/supabase/queries/productos"
import { getProductosByCategoria } from "@/lib/supabase/queries/store"

export default async function CategoryPage({
  params,
}: {
  params: {
    slug: string
  }
}) {
  const categoria = await getCategoriaBySlug(
    params.slug
  )

  if (!categoria) {
    notFound()
  }

  const categoryProducts = await getProductosByCategoria(params.slug)

  return (
    <CategoryPageLayout
      title={categoria.nombre}
      description={
        categoria.descripcion || ""
      }
      currentSlug={categoria.slug}
      products={categoryProducts}
    />
  )
}
