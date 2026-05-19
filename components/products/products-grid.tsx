"use client"

import SharedProductCard from "@/components/products/shared/shared-product-card"
import type { ProductItem } from "@/components/products/product-details"

interface ProductsGridProps {
  products: ProductItem[]
  selectedColors: string[]
  onOpenPreview: (product: ProductItem) => void
  onAddToCart: (product: ProductItem, color: string) => void
}

export function ProductsGrid({
  products,
  selectedColors,
  onOpenPreview,
  onAddToCart,
}: ProductsGridProps) {
  return (
    <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
      {products.map((product) => (
        <SharedProductCard
          key={product.id}
          product={product}
          selectedColors={selectedColors}
          onOpenPreview={onOpenPreview}
          onAddToCart={onAddToCart}
        />
      ))}
    </div>
  )
}