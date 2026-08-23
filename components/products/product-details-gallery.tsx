"use client"

import { useEffect, useRef, useState } from "react"

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
  // Set (no un único valor) para que una imagen ya vista no vuelva a mostrar
  // el skeleton/fade al reseleccionarla: una vez cargada, queda marcada.
  const [loadedMediaKeys, setLoadedMediaKeys] = useState<Set<string>>(
    () => new Set(),
  )
  const markMediaLoaded = (key: string) => {
    setLoadedMediaKeys((current) => {
      if (current.has(key)) return current
      const next = new Set(current)
      next.add(key)
      return next
    })
  }
  const [thumbnailStart, setThumbnailStart] = useState(0)
  const [thumbnailWindowSize, setThumbnailWindowSize] = useState(5)
  const thumbnailCarouselRef = useRef<HTMLDivElement>(null)

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
  const currentMediaKey = isVideoSelected
    ? `video:${videoUrl || ""}`
    : `image:${safeCurrentImage}`
  const isLoaded = loadedMediaKeys.has(currentMediaKey)
  const maxThumbnailStart = Math.max(0, mediaCount - thumbnailWindowSize)
  const visibleMedia = mediaItems.slice(
    thumbnailStart,
    thumbnailStart + thumbnailWindowSize,
  )
  const hiddenRightCount = Math.max(
    0,
    mediaCount - (thumbnailStart + visibleMedia.length),
  )
  const stockBadge = getStockBadge(selectedStock)

  const hasThumbnailRow = mediaCount > 1

  useEffect(() => {
    // El contenedor de miniaturas solo existe en el DOM cuando hay más de un
    // elemento (`hasThumbnailRow`); al pasar por una variante de una sola
    // imagen se desmonta y, al volver, React crea un nodo nuevo. Con un
    // efecto de dependencias vacías el observer quedaba atado para siempre
    // al primer nodo medido y nunca volvía a actualizar `thumbnailWindowSize`
    // para los nodos siguientes. Dependiendo de `hasThumbnailRow` el efecto
    // se re-ejecuta cada vez que el contenedor (re)aparece y vuelve a medir
    // el ancho real que tiene en ese momento.
    const carousel = thumbnailCarouselRef.current
    if (!carousel) return

    const updateWindowSize = () => {
      const width = carousel.clientWidth
      const nextWindowSize =
        width >= 530 ? 5 : width >= 450 ? 4 : width >= 285 ? 3 : 2

      setThumbnailWindowSize(nextWindowSize)
    }

    updateWindowSize()

    const resizeObserver = new ResizeObserver(updateWindowSize)
    resizeObserver.observe(carousel)

    return () => resizeObserver.disconnect()
  }, [hasThumbnailRow])

  useEffect(() => {
    setThumbnailStart((current) => {
      const clampedCurrent = Math.min(current, maxThumbnailStart)

      if (safeIndex < clampedCurrent) return safeIndex
      if (safeIndex >= clampedCurrent + thumbnailWindowSize) {
        return Math.min(
          safeIndex - thumbnailWindowSize + 1,
          maxThumbnailStart,
        )
      }

      return clampedCurrent
    })
  }, [maxThumbnailStart, safeIndex, thumbnailWindowSize])

  const handleNext = () => {
    setThumbnailStart((current) => Math.min(current + 1, maxThumbnailStart))
    onNext()
  }

  const handlePrev = () => {
    setThumbnailStart((current) => Math.max(current - 1, 0))
    onPrev()
  }

  return (
    <div className="flex min-h-0 flex-col overflow-hidden bg-[#080D13] px-4 pb-4 pt-4 sm:px-6 sm:pb-5 sm:pt-5">
      <div className="relative flex min-h-290px flex-1 items-center justify-center sm:min-h-380px md:min-h-0">
        <div className="flex h-full min-h-0 w-full items-center justify-center">
          <div
            className="relative flex aspect-square h-auto w-full max-w-[min(100%,660px)] items-center justify-center overflow-hidden rounded-2xl bg-white shadow-[0_22px_58px_rgba(0,0,0,0.3)] md:max-h-[660px]"
          >
            {isVideoSelected && playableVideo ? (
              <ProductVideoPlayer
                source={playableVideo}
                productName={productName}
                onLoaded={() => markMediaLoaded(currentMediaKey)}
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
                  markMediaLoaded(currentMediaKey)
                }}
                className={`h-full w-full object-contain p-1.5 transition-opacity duration-300 sm:p-2 ${
                  isLoaded
                    ? "opacity-100"
                    : "opacity-0"
                }`}
              />
            )}

            {/* Precarga en segundo plano del resto de la galería: una vez
                visible la imagen principal, se piden las demás por el mismo
                pipeline de next/image (mismo ancho) para que cambiar de
                miniatura después sea instantáneo en vez de recién disparar
                la transformación al hacer click. */}
            {isLoaded && (
              <div aria-hidden="true" className="hidden">
                {images.map((image) => {
                  if (!image) return null
                  const key = `image:${image}`
                  if (key === currentMediaKey || loadedMediaKeys.has(key)) {
                    return null
                  }

                  return (
                    <Image
                      key={key}
                      src={image}
                      alt=""
                      width={2000}
                      height={2000}
                      loading="eager"
                      onLoad={() => markMediaLoaded(key)}
                    />
                  )
                })}
              </div>
            )}

            {hasThumbnailRow && (
              <>
                <button
                  type="button"
                  aria-label="Imagen anterior"
                  onClick={handlePrev}
                  className="absolute left-3 top-1/2 z-10 flex size-10 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full border border-beyonix-sky/65 bg-[#07121E]/92 text-white shadow-[0_10px_26px_rgba(0,0,0,0.42)] backdrop-blur-sm transition-all hover:border-white hover:bg-[#112A43] active:scale-95"
                >
                  <ChevronLeft className="size-5 stroke-[2.6]" />
                </button>

                <button
                  type="button"
                  aria-label="Imagen siguiente"
                  onClick={handleNext}
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
          <div className="pointer-events-none absolute inset-0 animate-pulse rounded-2xl bg-white/4" />
        )}
      </div>

      {hasThumbnailRow && (
        <div className="flex h-34px shrink-0 items-end justify-center pt-2">
          <span className="text-11px font-bold tabular-nums tracking-widest text-white/40">
            {safeIndex + 1} / {mediaCount}
          </span>
        </div>
      )}

      {hasThumbnailRow && (
        <div className="flex h-78px shrink-0 items-end justify-center pt-2 sm:h-86px">
          <div
            ref={thumbnailCarouselRef}
            className="flex w-full max-w-[560px] min-w-0 items-center justify-center gap-2"
          >
            {hasThumbnailRow && (
              <button
                type="button"
                aria-label="Ver miniatura anterior"
                title="Anterior"
                onClick={handlePrev}
                className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full border border-beyonix-sky/35 bg-[#07121E] text-white/80 transition hover:border-beyonix-sky hover:bg-[#112A43] hover:text-white active:scale-95 sm:size-9"
              >
                <ChevronLeft className="size-4 stroke-[2.6]" />
              </button>
            )}

            <div className="flex min-w-0 items-center justify-center gap-2.5 px-1 py-1">
              {visibleMedia.map((media, visibleIndex) => {
                const index = thumbnailStart + visibleIndex
                const isVideo = media.type === "video"
                const image =
                  media.type === "image"
                    ? images[media.imageIndex]
                    : null

                return (
                  <ProductMediaThumbnail
                    key={isVideo ? "product-video" : `product-image:${image}`}
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

            <span
              aria-label={
                hiddenRightCount
                  ? `${hiddenRightCount} ${hiddenRightCount === 1 ? "elemento más" : "elementos más"}`
                  : undefined
              }
              className={`w-7 shrink-0 text-center text-xs font-bold tabular-nums text-white/38 ${
                hiddenRightCount ? "visible" : "invisible"
              }`}
            >
              +{hiddenRightCount}
            </span>

            {hasThumbnailRow && (
              <button
                type="button"
                aria-label="Ver miniatura siguiente"
                title="Siguiente"
                onClick={handleNext}
                className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full border border-beyonix-sky/35 bg-[#07121E] text-white/80 transition hover:border-beyonix-sky hover:bg-[#112A43] hover:text-white active:scale-95 sm:size-9"
              >
                <ChevronRight className="size-4 stroke-[2.6]" />
              </button>
            )}
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
        aria-label={`Video de ${productName}`}
        onLoadedMetadata={onLoaded}
        className="size-full bg-black object-contain"
      />
    )
  }

  return (
    <iframe
      src={source.embedUrl}
      title={`Video de ${productName}`}
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
      data-media-index={index}
      aria-label={label}
      onClick={() => onSelectImage(index)}
      className={`group relative size-12 cursor-pointer overflow-hidden rounded-xl transition-all duration-200 sm:size-16 md:size-[72px] ${
        isActive
          ? "scale-105 ring-2 ring-beyonix-sky ring-offset-2 ring-offset-[#080D13] shadow-[0_10px_24px_rgba(0,0,0,0.35)]"
          : "opacity-78 ring-1 ring-white/10 hover:scale-105 hover:opacity-100 hover:ring-beyonix-blue-light/55"
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
