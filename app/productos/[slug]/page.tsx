import { notFound } from "next/navigation"
import { getProductoBySlug } from "@/lib/supabase/queries/store"
import { ProductPageLayout } from "@/components/products/product-page-layout"

interface Props {
  params: Promise<{
    slug: string
  }>
}

export default async function ProductoPage({ params }: Props) {
  const { slug } = await params

  const producto = await getProductoBySlug(slug)

  if (!producto) notFound()

  return <ProductPageLayout producto={producto} />
}