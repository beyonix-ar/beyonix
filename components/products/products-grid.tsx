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
    <div className="grid grid-cols-1 items-stretch justify-start justify-items-stretch gap-[clamp(1rem,1.4vw,1.35rem)] sm:grid-cols-product-cards-2 xl:grid-cols-product-cards-4">
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
