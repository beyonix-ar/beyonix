"use client"

import { useState } from "react"

import { useCart } from "@/context/cart-context"
import { ProductDetailsModal } from "@/components/products/product-details-modal"
import type { SupabaseProducto } from "@/lib/supabase/types"
import {
  getDefaultVariantValue,
  getProductImagesByVariant,
} from "@/lib/products/product-variants"

interface AdminProductPreviewModalProps {
  product: SupabaseProducto
  onClose: () => void
}

export function AdminProductPreviewModal({
  product,
  onClose,
}: AdminProductPreviewModalProps) {
  const [selectedColor, setSelectedColor] = useState(() =>
    getDefaultVariantValue(product)
  )
  const [selectedImage, setSelectedImage] = useState(0)
  const {
    addToCart,
    decreaseQuantity,
    removeFromCart,
    getQuantity,
    isInCart,
    openCart,
  } = useCart()

  const images = getProductImagesByVariant(product, selectedColor)
  const safeImages =
    images.length > 0
      ? images
      : product.imagen_principal
        ? [product.imagen_principal]
        : []
  const currentImage = safeImages[selectedImage] || product.imagen_principal
  const cartQuantity = getQuantity(product.id, selectedColor)

  const handleColorChange = (value: string) => {
    setSelectedColor(value)
    setSelectedImage(0)
  }

  const handleNext = () => {
    setSelectedImage((current) =>
      safeImages.length > 0 ? (current + 1) % safeImages.length : 0
    )
  }

  const handlePrev = () => {
    setSelectedImage((current) =>
      safeImages.length > 0
        ? (current - 1 + safeImages.length) % safeImages.length
        : 0
    )
  }

  return (
    <ProductDetailsModal
      open
      product={product}
      images={safeImages}
      selectedImage={selectedImage}
      selectedColor={selectedColor}
      onClose={onClose}
      onNext={handleNext}
      onPrev={handlePrev}
      onSelectImage={setSelectedImage}
      onColorChange={handleColorChange}
      onAddToCart={() => {
        addToCart(product, selectedColor, currentImage || undefined)
      }}
      onDecreaseCart={() => {
        decreaseQuantity(product.id, selectedColor)
      }}
      onRemoveFromCart={() => {
        removeFromCart(product.id, selectedColor)
      }}
      onViewCart={openCart}
      isInCart={isInCart(product.id, selectedColor)}
      cartQuantity={cartQuantity}
    />
  )
}
