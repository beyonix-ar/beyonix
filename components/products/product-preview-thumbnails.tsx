"use client"

import Image from "next/image"

interface ProductPreviewThumbnailsProps {
  images: string[]
  selectedImage: number
  onSelectImage: (index: number) => void
  productName: string
}

export function ProductPreviewThumbnails({
  images,
  selectedImage,
  onSelectImage,
  productName,
}: ProductPreviewThumbnailsProps) {
  if (images.length <= 1) return null

  return (
    <div className="flex items-center justify-center gap-2">
      {images.map((image, index) => {
        const isActive = selectedImage === index

        return (
          <button
            key={`${image}-${index}`}
            type="button"
            title={`Ver imagen ${index + 1}`}
            aria-label={`Ver imagen ${index + 1}`}
            onClick={() => onSelectImage(index)}
            className={`group relative h-14 w-14 overflow-hidden rounded-lg border transition-all duration-200 cursor-pointer ${
              isActive
                ? "border-white/50 bg-white shadow-md scale-105"
                : "border-white/10 bg-white/90 hover:border-white/30 hover:scale-105"
            }`}
          >
            <Image
              src={image}
              alt={`${productName} miniatura ${index + 1}`}
              fill
              sizes="56px"
              className="object-contain p-0.5"
            />
          </button>
        )
      })}
    </div>
  )
}