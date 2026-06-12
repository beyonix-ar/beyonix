"use client"

import SharedProductCard from "@/components/products/shared/shared-product-card"
import type { SupabaseProducto } from "@/lib/supabase/types"

interface ProductsGridProps {
  products: SupabaseProducto[]
  onOpenPreview: (product: SupabaseProducto) => void
  onAddToCart: (product: SupabaseProducto, color: string, image?: string) => void
}

export function ProductsGrid({
  products,
  onOpenPreview,
  onAddToCart,
}: ProductsGridProps) {
  return (
    <div className="grid grid-cols-1 items-stretch justify-start justify-items-stretch gap-4 sm:grid-cols-product-cards-2 xl:grid-cols-category-product-cards-4 min-[1500px]:grid-cols-[repeat(4,minmax(0,276px))]">
      {products.map((product) => (
        <SharedProductCard
          key={product.id}
          product={product}
          onOpenPreview={onOpenPreview}
          onAddToCart={onAddToCart}
        />
      ))}
    </div>
  )
}
