"use client"

import type {
  ImgHTMLAttributes,
  SyntheticEvent,
} from "react"

import {
  SILVER_IMAGE_BACKGROUND,
  useImageTransparency,
} from "@/hooks/use-image-transparency"

interface TransparencyAwareImageProps
  extends Omit<
    ImgHTMLAttributes<HTMLImageElement>,
    "src"
  > {
  src: string
  /** Fondo detrás de un PNG transparente; por defecto el plateado de catálogo. */
  transparentBackground?: string
}

export function TransparencyAwareImage({
  src,
  onLoad,
  style,
  transparentBackground = SILVER_IMAGE_BACKGROUND,
  ...props
}: TransparencyAwareImageProps) {
  const {
    hasTransparentBackground,
    detectTransparency,
  } = useImageTransparency(src)

  const handleLoad = (
    event: SyntheticEvent<HTMLImageElement>
  ) => {
    detectTransparency(event)
    onLoad?.(event)
  }

  return (
    <img
      {...props}
      src={src}
      crossOrigin="anonymous"
      onLoad={handleLoad}
      style={{
        ...style,
        background:
          hasTransparentBackground
            ? transparentBackground
            : style?.background,
      }}
    />
  )
}
