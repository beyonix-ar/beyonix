"use client"

import { useState } from "react"

import { useCart } from "@/context/cart-context"
import { ProductDetailsModal } from "@/components/products/product-details-modal"
import type { SupabaseProducto } from "@/lib/supabase/types"
import {
  getDefaultVariantValue,
  getProductImagesByVariant,
} from "@/lib/products/product-variants"
import {
  getImageUrlFromMediaIndex,
  isPlayableProductVideo,
} from "@/lib/products/product-video"

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
  const currentImage =
    getImageUrlFromMediaIndex(
      safeImages,
      selectedImage,
      product.video_url
    ) || product.imagen_principal
  const mediaCount =
    safeImages.length + (isPlayableProductVideo(product.video_url) ? 1 : 0)
  const cartQuantity = getQuantity(product.id, selectedColor)

  const handleColorChange = (value: string) => {
    setSelectedColor(value)
    setSelectedImage(0)
  }

  const handleNext = () => {
    setSelectedImage((current) =>
      mediaCount > 0 ? (current + 1) % mediaCount : 0
    )
  }

  const handlePrev = () => {
    setSelectedImage((current) =>
      mediaCount > 0
        ? (current - 1 + mediaCount) % mediaCount
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
