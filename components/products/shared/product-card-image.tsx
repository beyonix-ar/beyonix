"use client"

import { ChevronLeft, ChevronRight } from "lucide-react"
import {
  SILVER_IMAGE_BACKGROUND,
  useImageTransparency,
} from "@/hooks/use-image-transparency"

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
  const {
    hasTransparentBackground,
    detectTransparency,
  } = useImageTransparency(image)

  return (
    <div
      onClick={onOpenPreview}
      className="relative aspect-square w-full shrink-0 cursor-pointer overflow-hidden border-b border-white/7 bg-beyonix-surface-3 p-2 sm:p-2.5"
    >
      <div
        className="h-full w-full overflow-hidden rounded-lg border border-white/6 bg-beyonix-surface-2"
        style={{
          background:
            hasTransparentBackground
              ? SILVER_IMAGE_BACKGROUND
              : undefined,
        }}
      >
        <img
          src={image}
          alt={productName}
          crossOrigin="anonymous"
          onLoad={
            detectTransparency
          }
          className="h-full w-full object-contain p-1 transition-transform duration-500 group-hover:scale-[1.025]"
        />
      </div>

      {/* Overlay sutil al hover para indicar que es clickeable */}
      <div className="pointer-events-none absolute inset-2 rounded-lg bg-black/0 transition-colors duration-200 group-hover:bg-black/5 sm:inset-2.5" />

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
