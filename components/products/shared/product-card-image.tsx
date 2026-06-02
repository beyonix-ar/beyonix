"use client"

import { ChevronLeft, ChevronRight } from "lucide-react"

interface ProductCardImageProps {
  image: string
  canNavigate: boolean
  onPrev: () => void
  onNext: () => void
  productName: string
  onOpenPreview?: () => void
}

export function ProductCardImage({
  image,
  canNavigate,
  onPrev,
  onNext,
  productName,
  onOpenPreview,
}: ProductCardImageProps) {
  return (
    <div
      onClick={onOpenPreview}
      className="relative h-220px shrink-0 cursor-pointer overflow-hidden bg-beyonix-surface-3 p-2 sm:h-240px"
    >
      <img
        src={image}
        alt={productName}
        className="h-full w-full object-contain transition-transform duration-500 hover:scale-105"
      />

      {/* Overlay sutil al hover para indicar que es clickeable */}
      <div className="absolute inset-0 bg-black/0 hover:bg-black/10 transition-colors duration-200" />

      {canNavigate && (
        <>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onPrev()
            }}
            aria-label="Imagen anterior"
            title="Imagen anterior"
            className="absolute left-2 top-1/2 z-10 flex size-7 -translate-y-1/2 items-center justify-center rounded-full bg-beyonix-blue/90 text-white shadow-lg backdrop-blur-sm border border-white/10 opacity-0 group-hover:opacity-100 transition-all duration-200 hover:scale-110 hover:bg-beyonix-blue-light cursor-pointer"
          >
            <ChevronLeft className="size-4" />
          </button>

          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onNext()
            }}
            aria-label="Imagen siguiente"
            title="Imagen siguiente"
            className="absolute right-2 top-1/2 z-10 flex size-7 -translate-y-1/2 items-center justify-center rounded-full bg-beyonix-blue/90 text-white shadow-lg backdrop-blur-sm border border-white/10 opacity-0 group-hover:opacity-100 transition-all duration-200 hover:scale-110 hover:bg-beyonix-blue-light cursor-pointer"
          >
            <ChevronRight className="size-4" />
          </button>
        </>
      )}
    </div>
  )
}
