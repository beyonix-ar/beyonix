"use client"

import { useState } from "react"

import type { SupabaseProducto } from "@/lib/supabase/types"
import { useCart } from "@/context/cart-context"
import {
  getDefaultVariantValue,
  getProductImagesByVariant,
  getVariantOptionByValue,
} from "@/lib/products/product-variants"

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
  const selectedVariant = getVariantOptionByValue(producto, selectedColor)
  const selectedStock = selectedVariant?.stock ?? producto.stock
  const cartQuantity = getQuantity(producto.id, selectedColor)

  const handleColorChange = (color: string) => {
    setSelectedColor(color)
    setSelectedImage(0)
  }

  const nextImage = () => {
    setSelectedImage((current) => (current + 1) % images.length)
  }

  const prevImage = () => {
    setSelectedImage((current) =>
      current === 0 ? images.length - 1 : current - 1,
    )
  }

  return (
    <main className="min-h-screen bg-black pt-24 text-white">
      <div className="grid lg:grid-cols-2">
        <ProductDetailsGallery
        images={images}
        selectedImage={selectedImage}
        productName={producto.nombre}
        selectedStock={selectedStock}
        onNext={nextImage}
        onPrev={prevImage}
        onSelectImage={setSelectedImage}
      />

        <ProductDetailsPanel
        product={producto}
        selectedColor={selectedColor}
        onColorChange={handleColorChange}
        onAddToCart={() => {
          addToCart(producto, selectedColor, images[selectedImage])
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
        />
      </div>
      <ProductReviews productId={producto.id} />
    </main>
  )
}
