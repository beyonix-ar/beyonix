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
}

export function TransparencyAwareImage({
  src,
  onLoad,
  style,
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
            ? SILVER_IMAGE_BACKGROUND
            : style?.background,
      }}
    />
  )
}
