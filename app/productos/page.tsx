import { Suspense } from "react"
import { ProductsPageLayout } from "@/components/products/products-page-layout"

export default function ProductosPage() {
  return (
    <Suspense fallback={<div>Cargando...</div>}>
      <ProductsPageLayout />
    </Suspense>
  )
}