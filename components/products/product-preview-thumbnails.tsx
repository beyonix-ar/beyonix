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
  if (images.length === 0) return null

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
            className={`group relative h-12 w-12 cursor-pointer overflow-hidden rounded-lg border bg-beyonix-surface-2 transition-all duration-200 ${
              isActive
                ? "scale-105 border-beyonix-sky shadow-beyonix-color-selected"
                : "border-white/10 hover:scale-105 hover:border-white/30"
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
