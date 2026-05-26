"use client"

import {
  useEffect,
  useState,
} from "react"

import Image from "next/image"

import {
  ChevronLeft,
  ChevronRight,
} from "lucide-react"

import { ProductPreviewThumbnails } from "./product-preview-thumbnails"

const IMAGE_SIZE_PERCENT = 82

interface ProductDetailsGalleryProps {
  images: string[]

  selectedImage: number

  productName: string

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

  useEffect(() => {
    setIsLoaded(false)
  }, [safeIndex])

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[#0a0a0a]">
      <div className="relative flex flex-1 items-center justify-center px-4">
        {images.length > 1 && (
          <button
            type="button"
            aria-label="Imagen anterior"
            title="Imagen anterior"
            onClick={onPrev}
            style={{
              left: "calc((100% - 82%) / 2 - 44px)",
            }}
            className="absolute z-10 flex h-9 w-9 cursor-pointer items-center justify-center rounded-full border border-white/25 bg-white/15 text-white/80 transition-all hover:border-white/40 hover:bg-white/25 hover:text-white active:scale-95"
          >
            <ChevronLeft className="size-4" />
          </button>
        )}

        <div
          style={{
            width: `${IMAGE_SIZE_PERCENT}%`,
          }}
          className="flex min-h-0 items-center justify-center"
        >
          <div className="flex aspect-square w-full items-center justify-center overflow-hidden rounded-xl bg-white">
            <Image
              src={currentImage}
              alt={`${productName} imagen ${safeIndex + 1}`}
              width={400}
              height={400}
              priority
              onLoad={() =>
                setIsLoaded(true)
              }
              className={`h-full w-full object-contain transition-opacity duration-300 ${
                isLoaded
                  ? "opacity-100"
                  : "opacity-0"
              }`}
            />
          </div>
        </div>

        {images.length > 1 && (
          <button
            type="button"
            aria-label="Imagen siguiente"
            title="Imagen siguiente"
            onClick={onNext}
            style={{
              right: "calc((100% - 82%) / 2 - 44px)",
            }}
            className="absolute z-10 flex h-9 w-9 cursor-pointer items-center justify-center rounded-full border border-white/25 bg-white/15 text-white/80 transition-all hover:border-white/40 hover:bg-white/25 hover:text-white active:scale-95"
          >
            <ChevronRight className="size-4" />
          </button>
        )}

        {!isLoaded && (
          <div className="absolute inset-0 animate-pulse bg-white/5" />
        )}
      </div>

      {images.length > 1 && (
        <div className="flex shrink-0 flex-col items-center gap-3 pb-6 pt-3">
          <span className="tabular-nums text-[13px] font-medium tracking-widest text-white/85">
            {safeIndex + 1} /{" "}
            {images.length}
          </span>

          <ProductPreviewThumbnails
            images={images}
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