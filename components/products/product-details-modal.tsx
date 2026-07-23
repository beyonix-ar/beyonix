"use client"

import { useEffect, useState } from "react"
import { createPortal } from "react-dom"
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
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

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

  if (!mounted || !open || !product) {
    return null
  }

  const selectedVariant = getVariantOptionByValue(product, selectedColor)
  const selectedStock = selectedVariant?.stock ?? product.stock

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#02070B]/88 px-4 py-5 backdrop-blur-lg">
      <button
        type="button"
        aria-label="Cerrar modal"
        onClick={onClose}
        className="absolute inset-0 cursor-pointer"
      />

      <div className="relative z-10 max-h-[calc(100vh-40px)] w-[min(1320px,calc(100vw-48px))] overflow-y-auto rounded-3xl border border-beyonix-blue-light/20 bg-[#080D13] shadow-[0_28px_90px_rgba(0,0,0,0.72),0_0_40px_rgba(30,140,255,0.055)] md:grid md:h-[min(840px,calc(100vh-40px))] md:grid-cols-[58fr_42fr] md:items-stretch md:overflow-hidden">
        <button
          type="button"
          aria-label="Cerrar detalle del producto"
          onClick={onClose}
          className="absolute right-4 top-4 z-30 flex size-10 cursor-pointer items-center justify-center rounded-full border border-white/12 bg-[#0B131C]/92 text-white/82 shadow-lg shadow-black/35 backdrop-blur-md transition-all hover:border-beyonix-sky/45 hover:bg-[#112A43] hover:text-white active:scale-95"
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
    </div>,
    document.body,
  )
}
