"use client"

import { useState } from "react"

import type { SupabaseProducto } from "@/lib/supabase/types"
import { useCart } from "@/context/cart-context"
import {
  getDefaultVariantValue,
  getProductImagesByVariant,
  getVariantOptionByValue,
  RANDOM_GALLERY_NOTE,
} from "@/lib/products/product-variants"
import {
  getImageUrlFromMediaIndex,
  isPlayableProductVideo,
} from "@/lib/products/product-video"

import { ProductDescriptionSection } from "./product-description-section"
import { ProductDetailsGallery } from "./product-details-gallery"
import { ProductDetailsPanel } from "./product-details-panel"
import { ProductReviews } from "./product-reviews"

interface ProductPageLayoutProps {
  producto: SupabaseProducto
}

export function ProductPageLayout({ producto }: ProductPageLayoutProps) {
  const [selectedImage, setSelectedImage] = useState(0)
  const [selectedColor, setSelectedColor] = useState(() =>
    getDefaultVariantValue(producto),
  )
  const {
    addToCart,
    decreaseQuantity,
    removeFromCart,
    getQuantity,
    isInCart,
    openCart,
  } = useCart()

  const images = getProductImagesByVariant(producto, selectedColor)
  const mediaCount =
    images.length + (isPlayableProductVideo(producto.video_url) ? 1 : 0)
  const selectedVariant = getVariantOptionByValue(producto, selectedColor)
  const selectedStock = selectedVariant?.stock ?? producto.stock
  const cartQuantity = getQuantity(producto.id, selectedColor)

  const handleColorChange = (color: string) => {
    setSelectedColor(color)
    setSelectedImage(0)
  }

  const nextImage = () => {
    setSelectedImage((current) => (current + 1) % Math.max(mediaCount, 1))
  }

  const prevImage = () => {
    setSelectedImage((current) =>
      current === 0 ? Math.max(mediaCount, 1) - 1 : current - 1,
    )
  }

  return (
    <main className="beyonix-pdp-page min-h-screen bg-black pt-24 text-white">
      <div className="grid min-w-0 lg:grid-cols-2">
        <ProductDetailsGallery
          images={images}
          selectedImage={selectedImage}
          productName={producto.nombre}
          selectedStock={selectedStock}
          videoUrl={producto.video_url}
          note={selectedVariant?.isRandom ? RANDOM_GALLERY_NOTE : null}
          onNext={nextImage}
          onPrev={prevImage}
          onSelectImage={setSelectedImage}
        />

        <ProductDetailsPanel
          product={producto}
          selectedColor={selectedColor}
          onColorChange={handleColorChange}
          onAddToCart={() => {
            addToCart(
              producto,
              selectedColor,
              getImageUrlFromMediaIndex(
                images,
                selectedImage,
                producto.video_url
              )
            )
          }}
          onDecreaseCart={() => {
            decreaseQuantity(producto.id, selectedColor)
          }}
          onRemoveFromCart={() => {
            removeFromCart(producto.id, selectedColor)
          }}
          onViewCart={openCart}
          isInCart={isInCart(producto.id, selectedColor)}
          cartQuantity={cartQuantity}
          selectedStock={selectedStock}
        />

        <ProductDescriptionSection
          key={producto.id}
          description={producto.descripcion}
          className="lg:col-span-2"
        />
      </div>
      <ProductReviews productId={producto.id} />
    </main>
  )
}
