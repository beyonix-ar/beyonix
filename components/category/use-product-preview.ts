"use client"

import { useCallback, useState } from "react"

export function useProductPreview() {
  const [previewOpen, setPreviewOpen] = useState(false)
  const [selectedImage, setSelectedImage] = useState(0)

  const openPreview = useCallback(() => {
    setSelectedImage(0)
    setPreviewOpen(true)
  }, [])

  const closePreview = useCallback(() => {
    setPreviewOpen(false)
  }, [])

  const nextImage = useCallback((totalImages: number) => {
    setSelectedImage((prev) =>
      prev === totalImages - 1 ? 0 : prev + 1
    )
  }, [])

  const prevImage = useCallback((totalImages: number) => {
    setSelectedImage((prev) =>
      prev === 0 ? totalImages - 1 : prev - 1
    )
  }, [])

  return {
    previewOpen,
    selectedImage,
    setSelectedImage,
    openPreview,
    closePreview,
    nextImage,
    prevImage,
  }
}