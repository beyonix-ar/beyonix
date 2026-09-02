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
  return (
    <button
      type="button"
      aria-label={`Ver imagen ${index + 1}`}
      onClick={() => onSelectImage(index)}
      className={`group relative h-12 w-12 cursor-pointer overflow-hidden rounded-lg bg-white transition-all duration-200 ${
        isActive
          ? "scale-105 border-2 border-[#112A43] shadow-beyonix-color-selected"
          : "border border-[#112A43] hover:scale-105"
      }`}
    >
      <Image
        src={image}
        alt={`${productName} miniatura ${index + 1}`}
        fill
        sizes="48px"
        className="object-contain p-1"
      />
    </button>
  )
}
