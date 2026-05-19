"use client"

import { useEffect } from "react"
import { X } from "lucide-react"
import { ProductItem } from "./product-details"
import { ProductDetailsGallery } from "./product-details-gallery"
import { ProductDetailsPanel } from "./product-details-panel"

interface ProductDetailsModalProps {
  open: boolean
  product: ProductItem | null
  images: string[]
  selectedImage: number
  selectedColor: string
  onClose: () => void
  onNext: () => void
  onPrev: () => void
  onSelectImage: (index: number) => void
  onColorChange: (colorName: string) => void
  onAddToCart: (quantity?: number) => void
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
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }

    if (open) {
      const scrollBarWidth =
        window.innerWidth - document.documentElement.clientWidth
      document.body.style.overflow = "hidden"
      document.documentElement.style.overflow = "hidden"
      document.body.style.paddingRight = `${scrollBarWidth}px`
      window.addEventListener("keydown", handleKey)
    } else {
      document.body.style.overflow = ""
      document.documentElement.style.overflow = ""
      document.body.style.paddingRight = ""
    }

    return () => {
      document.body.style.overflow = ""
      document.documentElement.style.overflow = ""
      document.body.style.paddingRight = ""
      window.removeEventListener("keydown", handleKey)
    }
  }, [open, onClose])

  if (!open || !product) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm px-4 py-6">

      <div className="absolute inset-0 cursor-pointer" onClick={onClose} />

      <div
        onClick={(e) => e.stopPropagation()}
        className="relative z-10 h-[90vh] w-full max-w-6xl overflow-hidden rounded-2xl border border-white/[0.12] bg-[#0a0a0a] shadow-[0_32px_80px_rgba(0,0,0,0.8)] lg:grid lg:grid-cols-[55fr_45fr] lg:items-stretch"
      >
        <button
          type="button"
          aria-label="Cerrar detalle del producto"
          title="Cerrar"
          onClick={onClose}
          className="absolute right-4 top-4 z-30 flex h-8 w-8 items-center justify-center rounded-full border border-white/25 bg-white/15 text-white/80 transition-all hover:bg-white/25 hover:text-white active:scale-95 cursor-pointer"
        >
          <X className="size-3.5" />
        </button>

        <ProductDetailsGallery
          images={images}
          selectedImage={selectedImage}
          productName={product.name}
          onNext={onNext}
          onPrev={onPrev}
          onSelectImage={onSelectImage}
        />

        <div className="absolute inset-y-0 left-[55%] hidden w-px bg-white/[0.08] lg:block" />

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
        />
      </div>
    </div>
  )
}