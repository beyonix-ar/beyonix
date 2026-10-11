import { notFound } from "next/navigation"

import { CategoryPageLayout } from "@/components/category/layout/category-page-layout"

import {
  getCategoriaBySlug,
} from "@/lib/supabase/queries/productos"
import {
  getStoreCategorias,
  getStoreProductos,
} from "@/lib/supabase/queries/store"

export const dynamic = "force-dynamic"

type CategoryPageParams = Promise<{
  slug?: string
}>

export default async function Page({
  params,
}: {
  params: CategoryPageParams
}) {
  const resolvedParams = await params

  const slug =
    resolvedParams?.slug || ""

  const categoria = await getCategoriaBySlug(
    slug
  )

  if (!categoria) {
    notFound()
  }

  const [
    allProducts,
    categories,
  ] = await Promise.all([
    getStoreProductos(),
    getStoreCategorias(),
  ])

  return (
    <CategoryPageLayout
      title={categoria.nombre}
      description={
        categoria.descripcion || ""
      }
      image={categoria.imagen || null}
      currentSlug={categoria.slug}
      products={allProducts}
      categories={categories}
    />
  )
}
