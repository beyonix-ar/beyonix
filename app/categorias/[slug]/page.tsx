import { notFound } from "next/navigation"

import { CategoryPageLayout } from "@/components/category/layout/category-page-layout"

import {
  getCategoriaBySlug,
} from "@/lib/supabase/queries/productos"
import {
  getProductosByCategoriaId,
  getStoreProductos,
} from "@/lib/supabase/queries/store"

export const dynamic = "force-dynamic"

type CategoryPageParams =
  | {
      slug?: string
    }
  | Promise<{
      slug?: string
    }>

export default async function Page({
  params,
}: {
  params: CategoryPageParams
}) {
  const resolvedParams =
    await Promise.resolve(params)

  const slug =
    resolvedParams?.slug || ""

  const categoria = await getCategoriaBySlug(
    slug
  )

  if (!categoria) {
    notFound()
  }

  const [
    categoryProducts,
    allProducts,
  ] = await Promise.all([
    getProductosByCategoriaId(
      categoria.id
    ),
    getStoreProductos(),
  ])

  return (
    <CategoryPageLayout
      title={categoria.nombre}
      description={
        categoria.descripcion || ""
      }
      image={categoria.imagen || null}
      currentSlug={categoria.slug}
      products={categoryProducts}
      priceRangeProducts={allProducts}
    />
  )
}
