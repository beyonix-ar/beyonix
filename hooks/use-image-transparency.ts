"use client"

import {
  useCallback,
  useEffect,
  useState,
  type SyntheticEvent,
} from "react"

const SAMPLE_SIZE = 64
const TRANSPARENCY_THRESHOLD = 250

export const SILVER_IMAGE_BACKGROUND =
  "linear-gradient(145deg, #f1f2f2 0%, #dfe1e2 52%, #cfd2d4 100%)"

export function useImageTransparency(
  source: string
) {
  const [
    hasTransparentBackground,
    setHasTransparentBackground,
  ] = useState(false)

  useEffect(() => {
    setHasTransparentBackground(false)
  }, [source])

  const detectTransparency = useCallback(
    (
      event: SyntheticEvent<HTMLImageElement>
    ) => {
      const image = event.currentTarget

      try {
        const scale = Math.min(
          1,
          SAMPLE_SIZE /
            Math.max(
              image.naturalWidth,
              image.naturalHeight
            )
        )
        const width = Math.max(
          1,
          Math.round(
            image.naturalWidth *
              scale
          )
        )
        const height = Math.max(
          1,
          Math.round(
            image.naturalHeight *
              scale
          )
        )
        const canvas =
          document.createElement(
            "canvas"
          )
        const context =
          canvas.getContext(
            "2d",
            {
              willReadFrequently:
                true,
            }
          )

        if (!context) {
          return
        }

        canvas.width = width
        canvas.height = height
        context.drawImage(
          image,
          0,
          0,
          width,
          height
        )

        const pixels =
          context.getImageData(
            0,
            0,
            width,
            height
          ).data

        for (
          let index = 3;
          index < pixels.length;
          index += 4
        ) {
          if (
            pixels[index] <
            TRANSPARENCY_THRESHOLD
          ) {
            setHasTransparentBackground(
              true
            )
            return
          }
        }

        setHasTransparentBackground(
          false
        )
      } catch {
        setHasTransparentBackground(
          false
        )
      }
    },
    []
  )

  return {
    hasTransparentBackground,
    detectTransparency,
  }
}
