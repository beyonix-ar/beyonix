"use client"

import { useEffect } from "react"
import { X } from "lucide-react"

import type { SupabaseProducto } from "@/lib/supabase/types"
import { getVariantOptionByValue } from "@/lib/products/product-variants"

import { ProductDetailsGallery } from "./product-details-gallery"
import { ProductDetailsPanel } from "./product-details-panel"

interface ProductDetailsModalProps {
  open: boolean

  product: SupabaseProducto | null

  images: string[]

  selectedImage: number
  selectedColor: string

  onClose: () => void
  onNext: () => void
  onPrev: () => void

  onSelectImage: (
    index: number
  ) => void

  onColorChange: (
    colorName: string
  ) => void

  onAddToCart: (
    quantity?: number
  ) => void

  onDecreaseCart: () => void

  onRemoveFromCart: () => void

  onViewCart: () => void

  isInCart?: boolean
  cartQuantity?: number
}

export function ProductDetailsModal({
  open,
  product,
  images,
  selectedImage,
  selectedColor,
  onClose,
  onNext,
  onPrev,
  onSelectImage,
  onColorChange,
  onAddToCart,
  onDecreaseCart,
  onRemoveFromCart,
  onViewCart,
  isInCart = false,
  cartQuantity = 0,
}: ProductDetailsModalProps) {
  useEffect(() => {
    const handleKeyDown = (
      event: KeyboardEvent
    ) => {
      if (event.key === "Escape") {
        onClose()
      }
    }

    if (open) {
      const scrollBarWidth =
        window.innerWidth -
        document.documentElement
          .clientWidth

      document.body.style.overflow =
        "hidden"

      document.body.style.paddingRight = `${scrollBarWidth}px`

      document.documentElement.style.overflow =
        "hidden"

      window.addEventListener(
        "keydown",
        handleKeyDown
      )
    }

    return () => {
      document.body.style.overflow = ""
      document.body.style.paddingRight =
        ""

      document.documentElement.style.overflow =
        ""

      window.removeEventListener(
        "keydown",
        handleKeyDown
      )
    }
  }, [open, onClose])

  if (!open || !product) {
    return null
  }

  const selectedVariant = getVariantOptionByValue(product, selectedColor)
  const selectedStock = selectedVariant?.stock ?? product.stock

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#02070B]/88 px-4 py-5 backdrop-blur-lg">
      <button
        type="button"
        aria-label="Cerrar modal"
        onClick={onClose}
        className="absolute inset-0 cursor-pointer"
      />

      <div className="relative z-10 max-h-[calc(100vh-40px)] w-[min(1320px,calc(100vw-48px))] overflow-y-auto rounded-2xl border border-beyonix-blue-light/28 bg-[#080B0F] shadow-[0_24px_72px_rgba(0,0,0,0.68),0_0_34px_rgba(30,140,255,0.08)] md:grid md:h-[min(840px,calc(100vh-40px))] md:grid-cols-[60fr_40fr] md:items-stretch md:overflow-hidden">
        <button
          type="button"
          aria-label="Cerrar detalle del producto"
          onClick={onClose}
          className="absolute right-4 top-4 z-30 flex size-10 cursor-pointer items-center justify-center rounded-full border border-beyonix-blue-light/36 bg-[#07121E]/95 text-white shadow-lg shadow-black/45 backdrop-blur-md transition-all hover:border-beyonix-sky/65 hover:bg-beyonix-blue/70 active:scale-95"
        >
          <X className="size-4" />
        </button>

        <ProductDetailsGallery
          images={images}
          selectedImage={selectedImage}
          productName={product.nombre}
          selectedStock={selectedStock}
          videoUrl={product.video_url}
          onNext={onNext}
          onPrev={onPrev}
          onSelectImage={onSelectImage}
        />

        <div className="absolute inset-y-0 left-[60%] hidden w-px bg-beyonix-blue-light/16 md:block" />

        <ProductDetailsPanel
          product={product}
          selectedColor={selectedColor}
          onColorChange={onColorChange}
          onAddToCart={onAddToCart}
          onDecreaseCart={onDecreaseCart}
          onRemoveFromCart={onRemoveFromCart}
          onViewCart={onViewCart}
          isInCart={isInCart}
          cartQuantity={cartQuantity}
          selectedStock={selectedStock}
        />
      </div>
    </div>
  )
}
