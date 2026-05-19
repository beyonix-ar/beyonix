"use client"

import Image from "next/image"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { ProductPreviewThumbnails } from "./product-preview-thumbnails"
import { useEffect, useState } from "react"

const IMAGE_SIZE_PERCENT = 82

interface ProductDetailsGalleryProps {
  images: string[]
  selectedImage: number
  productName: string
  onNext: () => void
  onPrev: () => void
  onSelectImage: (index: number) => void
}

export function ProductDetailsGallery({
  images,
  selectedImage,
  productName,
  onNext,
  onPrev,
  onSelectImage,
}: ProductDetailsGalleryProps) {
  const [isLoaded, setIsLoaded] = useState(false)

  const safeIndex =
    selectedImage >= 0 && selectedImage < images.length
      ? selectedImage
      : 0

  const currentImage = images[safeIndex] || "/placeholder.png"

  useEffect(() => {
    setIsLoaded(false)
  }, [safeIndex])

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#0a0a0a] overflow-hidden">

      <div className="relative flex flex-1 min-h-0 items-center justify-center px-4">

        {images.length > 1 && (
          <button
            type="button"
            aria-label="Imagen anterior"
            onClick={onPrev}
            style={{ left: "calc((100% - 82%) / 2 - 44px)" }}
            className="absolute z-10 flex h-9 w-9 items-center justify-center rounded-full border border-white/25 bg-white/15 text-white/80 transition-all hover:bg-white/25 hover:text-white hover:border-white/40 active:scale-95 cursor-pointer"
          >
            <ChevronLeft className="size-4" />
          </button>
        )}

        <div
          className="flex items-center justify-center min-h-0"
          style={{ width: `${IMAGE_SIZE_PERCENT}%` }}
        >
          <div className="w-full aspect-square rounded-xl flex items-center justify-center bg-white overflow-hidden">
            <Image
              src={currentImage}
              alt={`${productName} imagen ${safeIndex + 1}`}
              width={400}
              height={400}
              priority
              onLoadingComplete={() => setIsLoaded(true)}
              className={`object-contain w-full h-full transition-opacity duration-300 ${
                isLoaded ? "opacity-100" : "opacity-0"
              }`}
            />
          </div>
        </div>

        {images.length > 1 && (
          <button
            type="button"
            aria-label="Imagen siguiente"
            onClick={onNext}
            style={{ right: "calc((100% - 82%) / 2 - 44px)" }}
            className="absolute z-10 flex h-9 w-9 items-center justify-center rounded-full border border-white/25 bg-white/15 text-white/80 transition-all hover:bg-white/25 hover:text-white hover:border-white/40 active:scale-95 cursor-pointer"
          >
            <ChevronRight className="size-4" />
          </button>
        )}
      </div>

      {images.length > 1 && (
        <div className="shrink-0 flex flex-col items-center gap-3 pb-6 pt-3">
          <span className="text-[13px] font-medium text-white/85 tracking-widest tabular-nums">
            {safeIndex + 1} / {images.length}
          </span>

          <ProductPreviewThumbnails
            images={images}
            selectedImage={safeIndex}
            onSelectImage={onSelectImage}
            productName={productName}
          />
        </div>
      )}
    </div>
  )
}