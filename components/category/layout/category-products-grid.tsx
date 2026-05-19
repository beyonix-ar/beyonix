"use client"

import { CategoryProductCard } from "../category-product-card"
import { StoreProduct } from "@/lib/types/product"

interface CategoryProductsGridProps {
  products: StoreProduct[]
  onOpenPreview: (product: StoreProduct & { selectedColor: string }) => void
}

export function CategoryProductsGrid({
  products,
  onOpenPreview,
}: CategoryProductsGridProps) {
  return (
    <div className="category-products container relative z-0 mx-auto px-4 pb-20 lg:px-8">
      <div className="grid grid-cols-1 gap-10 -mt-8 items-stretch sm:grid-cols-2 xl:grid-cols-4">
        {products.map((product) => (
          <CategoryProductCard
            key={product.id}
            product={product}
            onOpenPreview={onOpenPreview}
          />
        ))}
      </div>
    </div>
  )
}