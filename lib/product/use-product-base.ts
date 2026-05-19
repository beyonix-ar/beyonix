"use client"

import { useMemo, useState } from "react"
import type { ProductItem } from "@/components/products/product-details"

export function useProductBase(product: ProductItem | null) {
  const [selectedColor, setSelectedColor] = useState<string>(
    product?.colors?.[0]?.name ?? ""
  )

  const activeVariant = useMemo(() => {
    if (!product) return null

    return (
      product.colors.find((c) => c.name === selectedColor) ??
      product.colors[0]
    )
  }, [product, selectedColor])

  const images =
    activeVariant?.images?.length
      ? activeVariant.images
      : ["/placeholder.svg"]

  return {
    selectedColor,
    setSelectedColor,
    activeVariant,
    images,
  }
}