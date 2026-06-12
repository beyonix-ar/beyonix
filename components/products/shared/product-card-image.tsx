"use client"

import {
  useEffect,
  useState,
  type SyntheticEvent,
} from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"

interface ProductCardImageProps {
  image: string
  canNavigate: boolean
  onPrev: () => void
  onNext: () => void
  productName: string
  onOpenPreview?: () => void
}

const TRANSPARENT_IMAGE_BACKGROUND =
  "#F2F7FF"

export function ProductCardImage({
  image,
  canNavigate,
  onPrev,
  onNext,
  productName,
  onOpenPreview,
}: ProductCardImageProps) {
  const [
    hasTransparentBackground,
    setHasTransparentBackground,
  ] = useState(false)

  useEffect(() => {
    setHasTransparentBackground(false)
  }, [image])

  const detectTransparency = (
    event: SyntheticEvent<HTMLImageElement>
  ) => {
    const source = event.currentTarget

    try {
      const sampleSize = 64
      const scale = Math.min(
        1,
        sampleSize /
          Math.max(
            source.naturalWidth,
            source.naturalHeight
          )
      )
      const width = Math.max(
        1,
        Math.round(
          source.naturalWidth *
            scale
        )
      )
      const height = Math.max(
        1,
        Math.round(
          source.naturalHeight *
            scale
        )
      )
      const canvas =
        document.createElement(
          "canvas"
        )
      const context =
        canvas.getContext(
          "2d",
          {
            willReadFrequently:
              true,
          }
        )

      if (!context) {
        return
      }

      canvas.width = width
      canvas.height = height
      context.drawImage(
        source,
        0,
        0,
        width,
        height
      )

      const pixels =
        context.getImageData(
          0,
          0,
          width,
          height
        ).data

      for (
        let index = 3;
        index < pixels.length;
        index += 4
      ) {
        if (pixels[index] < 250) {
          setHasTransparentBackground(
            true
          )
          return
        }
      }

      setHasTransparentBackground(
        false
      )
    } catch {
      setHasTransparentBackground(
        false
      )
    }
  }

  return (
    <div
      onClick={onOpenPreview}
      className="relative aspect-square w-full shrink-0 cursor-pointer overflow-hidden bg-beyonix-surface-3 p-[6px]"
    >
      <div
        className="h-full w-full overflow-hidden rounded-[3px]"
        style={{
          backgroundColor:
            hasTransparentBackground
              ? TRANSPARENT_IMAGE_BACKGROUND
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
          className="h-full w-full object-contain transition-transform duration-500 hover:scale-105"
        />
      </div>

      {/* Overlay sutil al hover para indicar que es clickeable */}
      <div className="pointer-events-none absolute inset-[6px] rounded-[3px] bg-black/0 transition-colors duration-200 group-hover:bg-black/10" />

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
