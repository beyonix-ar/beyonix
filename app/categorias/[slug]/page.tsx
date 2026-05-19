import { CategoryPageLayout } from "@/components/category/layout/category-page-layout"
import { productsData } from "@/lib/products"

const categoryMeta = {
  "audio-conectividad": {
    title: "Audio y conectividad",
    description: "Accesorios esenciales",
  },
  "confort-bienestar": {
    title: "Confort y bienestar",
    description: "Productos de comodidad",
  },
  "setup-escritorio": {
    title: "Setup y escritorio",
    description: "Zona productiva",
  },
} as const

export default function CategoryPage({
  params,
}: {
  params: { slug: string }
}) {
  const { slug } = params

  const meta = categoryMeta[slug as keyof typeof categoryMeta]

  if (!meta) {
    return <div className="p-10">Categoría no encontrada</div>
  }

  const categoryProducts = productsData.filter(
    (product) => product.categorySlug === slug
  )

  return (
    <CategoryPageLayout
      title={meta.title}
      description={meta.description}
      currentSlug={slug}
      products={categoryProducts}
    />
  )
}