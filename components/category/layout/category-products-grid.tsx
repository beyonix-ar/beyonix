"use client"

import type { SupabaseProducto } from "@/lib/supabase/types"

import { CategoryProductCard } from "../category-product-card"

interface CategoryProductsGridProps {
  products: SupabaseProducto[]

  onOpenPreview: (
    product: SupabaseProducto & {
      selectedColor: string
    }
  ) => void
}

export function CategoryProductsGrid({
  products,
  onOpenPreview,
}: CategoryProductsGridProps) {
  return (
    <div className="grid grid-cols-1 items-stretch gap-10 sm:grid-cols-2 xl:grid-cols-3">
      {products.map((product) => (
        <CategoryProductCard
          key={product.id}
          product={product}
          onOpenPreview={
            onOpenPreview
          }
        />
      ))}
    </div>
  )
}
