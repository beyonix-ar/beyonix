"use client"

import { useCallback, useState } from "react"
import { StoreProduct } from "@/lib/types/product"
import { useProductBase } from "@/lib/product/use-product-base"

export function useProductDetails() {
  const [isOpen, setIsOpen] = useState(false)
  const [product, setProduct] = useState<StoreProduct | null>(null)
  const [selectedImage, setSelectedImage] = useState(0)

  const {
    selectedColor,
    setSelectedColor,
    activeVariant,
    images,
  } = useProductBase(product)

  const openDetails = useCallback((nextProduct: StoreProduct) => {
    setProduct(nextProduct)
    setSelectedImage(0)
    setIsOpen(true)
  }, [])

  const closeDetails = useCallback(() => {
    setIsOpen(false)
    setTimeout(() => {
      setProduct(null)
      setSelectedImage(0)
    }, 200)
  }, [])

  const nextImage = useCallback(() => {
    setSelectedImage((prev) =>
      prev === images.length - 1 ? 0 : prev + 1
    )
  }, [images.length])

  const prevImage = useCallback(() => {
    setSelectedImage((prev) =>
      prev === 0 ? images.length - 1 : prev - 1
    )
  }, [images.length])

  const changeColor = useCallback((colorName: string) => {
    setSelectedColor(colorName)
    setSelectedImage(0)
  }, [setSelectedColor])

  const safeSelectedColor =
    selectedColor || activeVariant?.name || ""

  return {
    isOpen,
    product,
    selectedColor: safeSelectedColor,
    selectedImage,
    activeVariant,
    images,
    openDetails,
    closeDetails,
    nextImage,
    prevImage,
    changeColor,
    setSelectedImage,
  }
}