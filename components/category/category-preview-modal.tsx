"use client"

import { useEffect } from "react"
import Image from "next/image"
import { X, ChevronLeft, ChevronRight } from "lucide-react"
import { ColorSelector } from "../products/color-selector"
import { ProductPreviewThumbnails } from "../products/product-preview-thumbnails"

interface ProductColorVariant {
  name: string
  value: string
  images: string[]
}

interface ProductPreviewModalProps {
  open: boolean
  onClose: () => void
  images: string[]
  selectedImage: number
  selectedColor: string
  colors: ProductColorVariant[]
  productName: string
  onNext: () => void
  onPrev: () => void
  onSelectImage: (index: number) => void
  onColorChange: (colorName: string) => void
}

const actionButtonClass =
  "absolute z-30 rounded-full bg-beyonix-blue p-3 shadow-lg transition-all duration-300 hover:bg-beyonix-blue-hover hover:scale-105 active:scale-95"

export function ProductPreviewModal({
  open,
  onClose,
  images,
  selectedImage,
  selectedColor,
  colors,
  productName,
  onNext,
  onPrev,
  onSelectImage,
  onColorChange,
}: ProductPreviewModalProps) {
  useEffect(() => {
    document.body.classList.toggle("product-modal-open", open)

    return () => {
      document.body.classList.remove("product-modal-open")
    }
  }, [open])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 bg-black/85 flex items-center justify-center px-4 py-10">
      {/* click afuera */}
      <button
        type="button"
        aria-label="Cerrar modal"
        title="Cerrar modal"
        className="absolute inset-0 z-0"
        onClick={onClose}
      />

      {/* panel */}
      <div className="relative z-10 w-full max-w-5xl h-78vh rounded-3xl border border-white/10 bg-white shadow-2xl overflow-hidden">
        {/* cerrar */}
        <button
          type="button"
          aria-label="Cerrar vista previa"
          title="Cerrar vista previa"
          onClick={onClose}
          className={`${actionButtonClass} top-4 right-4`}
        >
          <X className="size-6 text-white" />
        </button>

        {/* izquierda */}
        {images.length > 1 && (
          <button
            type="button"
            aria-label="Imagen anterior"
            title="Imagen anterior"
            onClick={onPrev}
            className={`${actionButtonClass} left-4 top-1/2 -translate-y-1/2`}
          >
            <ChevronLeft className="size-7 text-white" />
          </button>
        )}

        {/* derecha */}
        {images.length > 1 && (
          <button
            type="button"
            aria-label="Imagen siguiente"
            title="Imagen siguiente"
            onClick={onNext}
            className={`${actionButtonClass} right-4 top-1/2 -translate-y-1/2`}
          >
            <ChevronRight className="size-7 text-white" />
          </button>
        )}

        {/* imagen */}
        <div className="relative z-0 h-full w-full">
          <Image
            src={images[selectedImage]}
            alt={`${productName} ${selectedImage + 1}`}
            fill
            priority
            className="pointer-events-none object-contain p-8"
          />
        </div>

        {/* miniaturas */}
        <ProductPreviewThumbnails
          images={images}
          selectedImage={selectedImage}
          onSelectImage={onSelectImage}
          productName={productName}
        />

        {/* colores */}
        <div className="absolute bottom-6 right-6 z-30">
          <ColorSelector
            colors={colors.map((color) => ({
              name: color.name,
              value: color.value as never,
            }))}
            selectedColor={selectedColor}
            onSelect={onColorChange}
          />
        </div>

        {/* contador */}
        {images.length > 1 && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-30 rounded-full bg-beyonix-blue px-4 py-2 text-sm text-white shadow-lg">
            {selectedImage + 1} / {images.length}
          </div>
        )}
      </div>
    </div>
  )
}
