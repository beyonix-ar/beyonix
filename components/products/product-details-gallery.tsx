"use client"

import { useEffect, useState } from "react"

import Image from "next/image"

import { ChevronLeft, ChevronRight, Play } from "lucide-react"

import { LOW_STOCK_THRESHOLD } from "@/lib/cart/stock-status"
import {
  getProductVideoSource,
  type ProductVideoSource,
} from "@/lib/products/product-video"

export function getStockBadge(stock: number) {
  if (stock <= 0) {
    return {
      text: "Sin stock",
      className: "border-red-300 bg-[#B91C1C] text-white shadow-[0_10px_24px_rgba(185,28,28,0.28)]",
    }
  }

  if (stock <= LOW_STOCK_THRESHOLD) {
    return {
      text: "Últimas unidades",
      className: "border-amber-200 bg-[#B7791F] text-white shadow-[0_10px_24px_rgba(183,121,31,0.28)]",
    }
  }

  return {
    text: "Stock disponible",
    className: "border-emerald-200 bg-[#067A46] text-white shadow-[0_10px_24px_rgba(6,122,70,0.28)]",
  }
}

type MediaItem =
  | {
      type: "image"
      imageIndex: number
    }
  | {
      type: "video"
    }

interface ProductDetailsGalleryProps {
  images: string[]

  selectedImage: number

  productName: string
  selectedStock: number
  videoUrl?: string | null

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
  videoUrl,
  onNext,
  onPrev,
  onSelectImage,
}: ProductDetailsGalleryProps) {
  const [isLoaded, setIsLoaded] =
    useState(false)

  const videoSource = getProductVideoSource(videoUrl)
  const playableVideo =
    videoSource && videoSource.kind !== "unsupported"
      ? videoSource
      : null
  const mediaItems: MediaItem[] = [
    ...(images[0]
      ? [
          {
            type: "image" as const,
            imageIndex: 0,
          },
        ]
      : []),
    ...(playableVideo
      ? [
          {
            type: "video" as const,
          },
        ]
      : []),
    ...images.slice(1).map((_, index) => ({
      type: "image" as const,
      imageIndex: index + 1,
    })),
  ]
  const mediaCount = mediaItems.length
  const safeIndex =
    selectedImage >= 0 &&
    selectedImage < mediaCount
      ? selectedImage
      : 0

  const currentMedia = mediaItems[safeIndex]
  const isVideoSelected =
    currentMedia?.type === "video"
  const currentImage =
    currentMedia?.type === "image"
      ? images[currentMedia.imageIndex]
      : "/placeholder.png"
  const safeCurrentImage =
    currentImage ||
    "/placeholder.png"
  const visibleMedia = mediaItems.slice(0, 5)
  const stockBadge = getStockBadge(selectedStock)

  useEffect(() => {
    setIsLoaded(false)
  }, [safeIndex])

  return (
    <div className="flex min-h-0 flex-col overflow-hidden bg-[#090D12] px-3 pb-3 pt-3 sm:px-4 sm:pb-4 sm:pt-4 md:h-full">
      <div className="relative flex min-h-290px flex-1 items-center justify-center rounded-2xl border border-beyonix-blue-light/18 bg-[#0D1118] p-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_18px_46px_rgba(0,0,0,0.28)] sm:min-h-380px sm:p-3 md:min-h-0">
        <div className="flex h-full min-h-0 w-full items-center justify-center">
          <div
            className="relative flex aspect-square h-auto w-full max-w-[min(100%,660px)] items-center justify-center overflow-hidden rounded-xl border border-white/10 bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.24),0_24px_60px_rgba(0,0,0,0.32)] md:max-h-[660px]"
          >
            {isVideoSelected && playableVideo ? (
              <ProductVideoPlayer
                source={playableVideo}
                productName={productName}
                onLoaded={() => setIsLoaded(true)}
              />
            ) : (
              <Image
                src={safeCurrentImage}
                alt={`${productName} imagen ${
                  currentMedia?.type === "image"
                    ? currentMedia.imageIndex + 1
                    : safeIndex + 1
                }`}
                width={2000}
                height={2000}
                priority
                onLoad={() => {
                  setIsLoaded(true)
                }}
                className={`h-full w-full object-contain p-1.5 transition-opacity duration-300 sm:p-2 ${
                  isLoaded
                    ? "opacity-100"
                    : "opacity-0"
                }`}
              />
            )}

            {mediaCount > 1 && (
              <>
                <button
                  type="button"
                  aria-label="Imagen anterior"
                  onClick={onPrev}
                  className="absolute left-3 top-1/2 z-10 flex size-10 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full border border-beyonix-sky/65 bg-[#07121E]/92 text-white shadow-[0_10px_26px_rgba(0,0,0,0.42)] backdrop-blur-sm transition-all hover:border-white hover:bg-[#112A43] active:scale-95"
                >
                  <ChevronLeft className="size-5 stroke-[2.6]" />
                </button>

                <button
                  type="button"
                  aria-label="Imagen siguiente"
                  onClick={onNext}
                  className="absolute right-3 top-1/2 z-10 flex size-10 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full border border-beyonix-sky/65 bg-[#07121E]/92 text-white shadow-[0_10px_26px_rgba(0,0,0,0.42)] backdrop-blur-sm transition-all hover:border-white hover:bg-[#112A43] active:scale-95"
                >
                  <ChevronRight className="size-5 stroke-[2.6]" />
                </button>
              </>
            )}

            <span
              className={`absolute right-3 top-3 rounded-full border px-3.5 py-1.5 text-13px font-black tracking-wide ${stockBadge.className}`}
            >
              {stockBadge.text}
            </span>
          </div>
        </div>

        {!isLoaded && (
          <div className="pointer-events-none absolute inset-0 animate-pulse bg-white/5" />
        )}
      </div>

      <div className="flex h-30px shrink-0 items-center justify-center sm:h-34px">
        <span className="rounded-full border border-white/8 bg-white/4 px-3 py-1 text-12px font-bold tabular-nums tracking-widest text-white/78">
          {safeIndex + 1} / {mediaCount || 1}
        </span>
      </div>

      {visibleMedia.length > 0 && (
        <div className="flex h-62px shrink-0 items-center justify-center sm:h-70px">
          <div className="flex items-center justify-center gap-2.5">
            {visibleMedia.map((media, index) => {
              const isVideo = media.type === "video"
              const image =
                media.type === "image"
                  ? images[media.imageIndex]
                  : null

              return (
                <ProductMediaThumbnail
                  key={isVideo ? "product-video" : `${image}-${index}`}
                  image={image}
                  index={index}
                  isActive={safeIndex === index}
                  isVideo={isVideo}
                  label={
                    isVideo
                      ? "Ver video"
                      : `Ver imagen ${
                          media.type === "image"
                            ? media.imageIndex + 1
                            : index + 1
                        }`
                  }
                  productName={productName}
                  onSelectImage={onSelectImage}
                />
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

interface ProductVideoPlayerProps {
  source: Exclude<ProductVideoSource, { kind: "unsupported" }>
  productName: string
  onLoaded: () => void
}

function ProductVideoPlayer({
  source,
  productName,
  onLoaded,
}: ProductVideoPlayerProps) {
  useEffect(() => {
    if (source.kind !== "direct") {
      onLoaded()
    }
  }, [onLoaded, source.kind])

  if (source.kind === "direct") {
    return (
      <video
        controls
        preload="metadata"
        src={source.videoUrl}
        onLoadedMetadata={onLoaded}
        className="size-full bg-black object-contain"
      />
    )
  }

  return (
    <iframe
      src={source.embedUrl}
      loading="lazy"
      allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
      allowFullScreen
      referrerPolicy="strict-origin-when-cross-origin"
      className="size-full bg-black"
    />
  )
}

interface ProductMediaThumbnailProps {
  image: string | null
  index: number
  isActive: boolean
  isVideo: boolean
  label: string
  productName: string
  onSelectImage: (index: number) => void
}

function ProductMediaThumbnail({
  image,
  index,
  isActive,
  isVideo,
  label,
  productName,
  onSelectImage,
}: ProductMediaThumbnailProps) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={() => onSelectImage(index)}
      className={`group relative size-16 cursor-pointer overflow-hidden rounded-xl border transition-all duration-200 sm:size-[72px] ${
        isActive
          ? "scale-105 border-beyonix-sky shadow-[0_0_0_3px_rgba(30,140,255,0.16),0_10px_24px_rgba(0,0,0,0.35)]"
          : "border-white/14 hover:scale-105 hover:border-beyonix-blue-light/65"
      } ${isVideo ? "bg-black" : "bg-white"}`}
    >
      {isVideo ? (
        <span className="flex size-full items-center justify-center bg-black text-white">
          <span className="flex size-8 items-center justify-center rounded-full border border-beyonix-sky/45 bg-beyonix-blue text-beyonix-sky shadow-[0_0_18px_rgba(30,140,255,0.25)]">
            <Play className="ml-0.5 size-4 fill-current" />
          </span>
        </span>
      ) : image ? (
        <Image
          src={image}
          alt={`${productName} miniatura ${index + 1}`}
          fill
          sizes="48px"
          className="object-contain p-1.5"
        />
      ) : null}
    </button>
  )
}
