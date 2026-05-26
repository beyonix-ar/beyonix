import { notFound } from "next/navigation"

import { CategoryPageLayout } from "@/components/category/layout/category-page-layout"

import {
  getCategoriaBySlug,
  getProductos,
} from "@/lib/supabase/queries/productos"

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

  const products = await getProductos()

  const categoryProducts = products.filter(
    (product) =>
      product.categorias?.slug === params.slug
  )

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