"use client"

import { useEffect, useState } from "react"
import Image from "next/image"
import { ChevronLeft, ChevronRight } from "lucide-react"

interface ProductImageCarouselProps {
  images: string[]
  alt: string
}

const arrowButtonClass =
  "absolute top-1/2 -translate-y-1/2 z-10 size-10 cursor-pointer rounded-full bg-beyonix-blue hover:bg-beyonix-blue-hover transition-colors duration-200 flex items-center justify-center shadow-lg"

export function ProductImageCarousel({
  images,
  alt,
}: ProductImageCarouselProps) {
  const [currentIndex, setCurrentIndex] = useState(0)

  useEffect(() => {
    setCurrentIndex(0)
  }, [images])

  const prevImage = () => {
    setCurrentIndex((prev) =>
      prev === 0 ? images.length - 1 : prev - 1
    )
  }

  const nextImage = () => {
    setCurrentIndex((prev) =>
      prev === images.length - 1 ? 0 : prev + 1
    )
  }

  return (
    <div className="product-card-image group relative h-full bg-beyonix-surface-3 overflow-hidden rounded-lg">
      <Image
        src={images[currentIndex]}
        alt={alt}
        width={500}
        height={500}
        className="h-full w-full scale-104 object-contain object-top transition-transform duration-500 group-hover:scale-108"
      />

      {images.length > 1 && (
        <>
          <button
            type="button"
            aria-label="Imagen anterior"
            title="Imagen anterior"
            onClick={(e) => {
              e.stopPropagation()
              prevImage()
            }}
            className={`${arrowButtonClass} left-1`}
          >
            <ChevronLeft className="size-6 text-white stroke-2-8" />
          </button>

          <button
            type="button"
            aria-label="Imagen siguiente"
            title="Imagen siguiente"
            onClick={(e) => {
              e.stopPropagation()
              nextImage()
            }}
            className={`${arrowButtonClass} right-1`}
          >
            <ChevronRight className="size-6 text-white stroke-2-8" />
          </button>
        </>
      )}
    </div>
  )
}
