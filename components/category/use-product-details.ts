"use client"

import {
  useCallback,
  useMemo,
  useState,
} from "react"

import type { SupabaseProducto } from "@/lib/supabase/types"
import {
  DEFAULT_VARIANT_VALUE,
  getDefaultVariantValue,
  getProductImagesByVariant,
} from "@/lib/products/product-variants"

export function useProductDetails() {
  const [isOpen, setIsOpen] =
    useState(false)

  const [product, setProduct] =
    useState<SupabaseProducto | null>(
      null
    )

  const [selectedImage, setSelectedImage] =
    useState(0)

  const [selectedColor, setSelectedColor] =
    useState(DEFAULT_VARIANT_VALUE)

  const images = useMemo(() => {
    if (!product) {
      return []
    }

    return getProductImagesByVariant(
      product,
      selectedColor
    )
  }, [product, selectedColor])

  const openDetails = useCallback(
    (
      nextProduct: SupabaseProducto
    ) => {
      setProduct(nextProduct)

      setSelectedImage(0)

      setSelectedColor(getDefaultVariantValue(nextProduct))

      setIsOpen(true)
    },
    []
  )

  const closeDetails = useCallback(() => {
    setIsOpen(false)

    setTimeout(() => {
      setProduct(null)

      setSelectedImage(0)
    }, 200)
  }, [])

  const nextImage = useCallback(() => {
    setSelectedImage((prev) =>
      prev === images.length - 1
        ? 0
        : prev + 1
    )
  }, [images.length])

  const prevImage = useCallback(() => {
    setSelectedImage((prev) =>
      prev === 0
        ? images.length - 1
        : prev - 1
    )
  }, [images.length])

  const changeColor = useCallback(
    (colorName: string) => {
      setSelectedColor(
        colorName
      )

      setSelectedImage(0)
    },
    []
  )

  return {
    isOpen,

    product,

    selectedColor,

    selectedImage,

    images,

    openDetails,
    closeDetails,

    nextImage,
    prevImage,

    changeColor,

    setSelectedImage,
  }
}
