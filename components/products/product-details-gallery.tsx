"use client"

import { useEffect, useState } from "react"

import Image from "next/image"

import { ChevronLeft, ChevronRight } from "lucide-react"

import { ProductPreviewThumbnails } from "./product-preview-thumbnails"
import { SITE_SETTINGS } from "@/config/site-settings"
import {
  SILVER_IMAGE_BACKGROUND,
  useImageTransparency,
} from "@/hooks/use-image-transparency"

export function getStockBadge(stock: number) {
  if (stock <= 0) {
    return {
      text: "Sin stock",
      className: "border-red-400/25 bg-red-500/12 text-red-100",
    }
  }

  if (stock <= SITE_SETTINGS.stock.criticalStockThreshold) {
    return {
      text: "Últimas unidades",
      className: "border-red-400/25 bg-red-500/12 text-red-100",
    }
  }

  if (stock <= SITE_SETTINGS.stock.lowStockThreshold) {
    return {
      text: "Últimas unidades",
      className: "border-amber-300/25 bg-amber-400/12 text-amber-100",
    }
  }

  return {
    text: "Stock disponible",
    className: "border-emerald-300/25 bg-emerald-400/12 text-emerald-100",
  }
}

interface ProductDetailsGalleryProps {
  images: string[]

  selectedImage: number

  productName: string
  selectedStock: number

  onNext: () => void
  onPrev: () => void

  onSelectImage: (
    index: number
  ) => void
}

export function ProductDetailsGallery({
  images,
  selectedImage,
  productName,
  selectedStock,
  onNext,
  onPrev,
  onSelectImage,
}: ProductDetailsGalleryProps) {
  const [isLoaded, setIsLoaded] =
    useState(false)

  const safeIndex =
    selectedImage >= 0 &&
    selectedImage < images.length
      ? selectedImage
      : 0

  const currentImage =
    images[safeIndex] ||
    "/placeholder.png"
  const {
    hasTransparentBackground,
    detectTransparency,
  } = useImageTransparency(currentImage)
  const visibleImages = images.slice(0, 5)
  const stockBadge = getStockBadge(selectedStock)

  useEffect(() => {
    setIsLoaded(false)
  }, [safeIndex])

  return (
    <div className="flex min-h-0 flex-col overflow-hidden bg-beyonix-surface px-3 pb-3 pt-3 sm:px-5 sm:pb-4 sm:pt-5 lg:h-full lg:px-6 lg:pb-5 lg:pt-6">
      <div className="relative flex min-h-300px flex-1 items-center justify-center rounded-xl border border-white/8 bg-beyonix-surface-3 p-2.5 sm:min-h-420px sm:p-3 lg:min-h-0 lg:rounded-2xl">
        <div className="flex h-full min-h-0 w-full items-center justify-center">
          <div
            className="relative flex aspect-square h-full max-h-full max-w-full items-center justify-center overflow-hidden rounded-xl border border-white/7 bg-beyonix-surface-2"
            style={{
              background:
                hasTransparentBackground
                  ? SILVER_IMAGE_BACKGROUND
                  : undefined,
            }}
          >
            <Image
              src={currentImage}
              alt={`${productName} imagen ${safeIndex + 1}`}
              width={2000}
              height={2000}
              priority
              onLoad={(event) => {
                detectTransparency(
                  event
                )
                setIsLoaded(true)
              }}
              className={`h-full w-full object-contain p-2 transition-opacity duration-300 sm:p-3 ${
                isLoaded
                  ? "opacity-100"
                  : "opacity-0"
              }`}
            />

            {images.length > 1 && (
              <>
                <button
                  type="button"
                  aria-label="Imagen anterior"
                  title="Imagen anterior"
                  onClick={onPrev}
                  className="absolute left-3 top-1/2 z-10 flex h-9 w-9 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full border border-white/18 bg-black/55 text-white/85 transition-all hover:border-beyonix-sky/50 hover:bg-black/75 hover:text-white active:scale-95"
                >
                  <ChevronLeft className="size-4" />
                </button>

                <button
                  type="button"
                  aria-label="Imagen siguiente"
                  title="Imagen siguiente"
                  onClick={onNext}
                  className="absolute right-3 top-1/2 z-10 flex h-9 w-9 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full border border-white/18 bg-black/55 text-white/85 transition-all hover:border-beyonix-sky/50 hover:bg-black/75 hover:text-white active:scale-95"
                >
                  <ChevronRight className="size-4" />
                </button>
              </>
            )}

            <span
              className={`absolute right-3 top-3 rounded-full border px-3 py-1 text-11px font-semibold tracking-wide ${stockBadge.className}`}
            >
              {stockBadge.text}
            </span>
          </div>
        </div>

        {!isLoaded && (
          <div className="pointer-events-none absolute inset-0 animate-pulse bg-white/5" />
        )}
      </div>

      <div className="flex h-32px shrink-0 items-center justify-center sm:h-38px">
        <span className="text-12px font-semibold tabular-nums tracking-widest text-white/70">
          {safeIndex + 1} / {images.length || 1}
        </span>
      </div>

      {visibleImages.length > 0 && (
        <div className="flex h-50px shrink-0 items-center justify-center sm:h-56px">
          <ProductPreviewThumbnails
            images={visibleImages}
            selectedImage={safeIndex}
            onSelectImage={
              onSelectImage
            }
            productName={productName}
          />
        </div>
      )}
    </div>
  )
}
