"use client"

import Image from "next/image"
import {
  SILVER_IMAGE_BACKGROUND,
  useImageTransparency,
} from "@/hooks/use-image-transparency"

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
      {images.map((image, index) => (
        <ProductPreviewThumbnail
          key={`${image}-${index}`}
          image={image}
          index={index}
          isActive={
            selectedImage === index
          }
          productName={productName}
          onSelectImage={
            onSelectImage
          }
        />
      ))}
    </div>
  )
}

interface ProductPreviewThumbnailProps {
  image: string
  index: number
  isActive: boolean
  productName: string
  onSelectImage: (index: number) => void
}

function ProductPreviewThumbnail({
  image,
  index,
  isActive,
  productName,
  onSelectImage,
}: ProductPreviewThumbnailProps) {
  const {
    hasTransparentBackground,
    detectTransparency,
  } = useImageTransparency(image)

  return (
    <button
      type="button"
      aria-label={`Ver imagen ${index + 1}`}
      onClick={() => onSelectImage(index)}
      className={`group relative h-12 w-12 cursor-pointer overflow-hidden rounded-lg border transition-all duration-200 ${
        isActive
          ? "scale-105 border-beyonix-sky shadow-beyonix-color-selected"
          : "border-white/10 hover:scale-105 hover:border-beyonix-blue-light/55"
      }`}
      style={{
        background:
          hasTransparentBackground
            ? SILVER_IMAGE_BACKGROUND
            : undefined,
      }}
    >
      <Image
        src={image}
        alt={`${productName} miniatura ${index + 1}`}
        fill
        sizes="48px"
        onLoad={detectTransparency}
        className="object-contain p-1"
      />
    </button>
  )
}
