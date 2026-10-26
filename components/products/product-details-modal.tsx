"use client"

import { useEffect, useState } from "react"
import { createPortal } from "react-dom"
import { X } from "lucide-react"

import type { SupabaseProducto } from "@/lib/supabase/types"
import { getVariantOptionByValue } from "@/lib/products/product-variants"
import { useProductViewTracking } from "@/hooks/use-product-view-tracking"

import { ProductDescriptionSection } from "./product-description-section"
import { ProductDetailsGallery } from "./product-details-gallery"
import { ProductDetailsPanel } from "./product-details-panel"
import { lockDocumentScroll } from "@/lib/admin/scroll-lock"

// Mobile: aire arriba/abajo respetando el safe-area (notch) y la tarjeta
// limitada al alto real del overlay (max-h-full). Con 100vh, en mobile la
// tarjeta medía más que el viewport visible y, centrada, quedaba pegada o
// cortada contra el borde superior. Desde sm se conserva el py-5 original.
export const PRODUCT_MODAL_OVERLAY_CLASS =
  "fixed inset-0 z-50 flex items-center justify-center bg-black/85 px-4 py-5 backdrop-blur-sm max-sm:pb-[calc(env(safe-area-inset-bottom,0px)+16px)] max-sm:pt-[calc(env(safe-area-inset-top,0px)+16px)]"

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

  /** Registra la apertura como `product_view` (tienda). La vista previa del Admin lo desactiva. */
  measureViews?: boolean
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
  measureViews = true,
}: ProductDetailsModalProps) {
  const [mounted, setMounted] = useState(false)

  useProductViewTracking(measureViews && open && product ? product.id : null, "quick_view")

  useEffect(() => {
    setMounted(true)
  }, [])

  useEffect(() => {
    const handleKeyDown = (
      event: KeyboardEvent
    ) => {
      if (event.key === "Escape" && !document.querySelector("[data-product-image-lightbox]")) {
        onClose()
      }
    }

    if (open) {
      window.addEventListener(
        "keydown",
        handleKeyDown
      )
    }

    return () => {
      window.removeEventListener(
        "keydown",
        handleKeyDown
      )
    }
  }, [open, onClose])

  // Bloqueo de scroll centralizado (anidable, robusto en iOS, conserva la
  // posición). Depende sólo de `open`: un onClose nuevo no lo re-aplica.
  useEffect(() => {
    if (!open) return
    return lockDocumentScroll({ preventTouchScroll: true })
  }, [open])

  if (!mounted || !open || !product) {
    return null
  }

  return createPortal(
    <div className={PRODUCT_MODAL_OVERLAY_CLASS}>
      <button
        type="button"
        aria-label="Cerrar modal"
        onClick={onClose}
        className="absolute inset-0 cursor-pointer"
      />

      <ProductDetailsModalCard
        product={product}
        images={images}
        selectedImage={selectedImage}
        selectedColor={selectedColor}
        onClose={onClose}
        onNext={onNext}
        onPrev={onPrev}
        onSelectImage={onSelectImage}
        onColorChange={onColorChange}
        onAddToCart={onAddToCart}
        onDecreaseCart={onDecreaseCart}
        onRemoveFromCart={onRemoveFromCart}
        onViewCart={onViewCart}
        isInCart={isInCart}
        cartQuantity={cartQuantity}
      />
    </div>,
    document.body,
  )
}

/**
 * Tarjeta del modal: galería + miniaturas a la izquierda, compra a la
 * derecha y la descripción a todo el ancho debajo (en mobile, apilado).
 */
export function ProductDetailsModalCard({
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
}: Omit<ProductDetailsModalProps, "open" | "product"> & { product: SupabaseProducto }) {
  const selectedVariant = getVariantOptionByValue(product, selectedColor)
  const selectedStock = selectedVariant?.stock ?? product.stock

  return (
    <div className="beyonix-modal-shell custom-scrollbar relative z-10 max-h-[calc(100vh-40px)] max-sm:max-h-full w-[min(1320px,calc(100vw-32px))] overflow-x-hidden overflow-y-auto rounded-3xl border border-beyonix-blue-light/20 bg-[#080D13] shadow-[0_28px_90px_rgba(0,0,0,0.72),0_0_40px_rgba(30,140,255,0.055)] md:grid md:grid-cols-[minmax(0,45fr)_minmax(0,55fr)] md:items-stretch">
      <button
        type="button"
        aria-label="Cerrar detalle del producto"
        onClick={onClose}
        className="beyonix-modal-close absolute right-4 top-4 z-30 flex size-10 cursor-pointer items-center justify-center rounded-full border border-white/12 bg-[#0B131C]/92 text-white/82 shadow-lg shadow-black/35 backdrop-blur-md transition-all hover:border-beyonix-sky/45 hover:bg-[#112A43] hover:text-white active:scale-95"
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

      <ProductDescriptionSection
        key={product.id}
        description={product.descripcion}
        className="md:col-span-2"
      />
    </div>
  )
}
