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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#02070B]/86 px-3 py-4 backdrop-blur-xl sm:px-5 sm:py-6">
      <button
        type="button"
        aria-label="Cerrar modal"
        onClick={onClose}
        className="absolute inset-0 cursor-pointer"
      />

      <div className="relative z-10 max-h-[94vh] w-full max-w-[1180px] overflow-y-auto rounded-2xl border border-beyonix-blue-light/24 bg-[#080B0F] shadow-[0_28px_90px_rgba(0,0,0,0.72),0_0_42px_rgba(30,140,255,0.08)] lg:grid lg:h-[min(88vh,860px)] lg:grid-cols-product-modal lg:items-stretch lg:overflow-hidden lg:rounded-3xl">
        <button
          type="button"
          aria-label="Cerrar detalle del producto"
          onClick={onClose}
          className="absolute right-4 top-4 z-30 flex size-10 cursor-pointer items-center justify-center rounded-full border border-beyonix-blue-light/28 bg-[#07121E]/88 text-white/78 shadow-lg shadow-black/45 backdrop-blur-md transition-all hover:border-beyonix-sky/55 hover:bg-beyonix-blue/55 hover:text-white active:scale-95"
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

        <div className="absolute inset-y-0 left-55pct hidden w-px bg-beyonix-blue-light/16 lg:block" />

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
