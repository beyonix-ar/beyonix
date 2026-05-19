"use client"

import { useMemo, useState, useEffect } from "react"
import type { ProductItem } from "@/components/products/product-details"
import { ProductCardImage } from "./product-card-image"
import { ProductCardColors } from "./product-card-colors"
import { ProductCardPricing } from "./product-card-pricing"
import { useCart } from "@/context/cart-context"

interface SharedProductCardProps {
  product: ProductItem
  selectedColors?: string[]
  onOpenPreview?: (product: ProductItem & { initialColor?: string }) => void
  onAddToCart?: (
    product: ProductItem,
    color: string,
    image?: string
  ) => void
}

export default function SharedProductCard({
  product,
  selectedColors = [],
  onOpenPreview,
  onAddToCart,
}: SharedProductCardProps) {

  const {
    getQuantity,
    increaseQuantity,
    decreaseQuantity,
  } = useCart()

  const initialColorIndex = useMemo(() => {
    if (!product.colors?.length || selectedColors.length === 0) return 0

    const index = product.colors.findIndex((color) =>
      selectedColors.includes(color.name.trim().toLowerCase())
    )

    return index >= 0 ? index : 0
  }, [product, selectedColors])

  const [selectedColorIndex, setSelectedColorIndex] =
    useState(initialColorIndex)

  const [selectedImageIndex, setSelectedImageIndex] =
    useState(0)

  useEffect(() => {
    if (!product.colors?.length) return

    if (selectedColors.length === 0) {
      setSelectedColorIndex(0)
      return
    }

    const index = product.colors.findIndex((color) =>
      selectedColors.includes(color.name.trim().toLowerCase())
    )

    if (index >= 0) {
      setSelectedColorIndex(index)
      setSelectedImageIndex(0)
    }
  }, [selectedColors, product.colors])

  const activeColor =
    product.colors?.[selectedColorIndex] ?? product.colors?.[0]

  const quantity = activeColor?.name
    ? getQuantity(product.id, activeColor.name)
    : 0

  const activeImages =
    activeColor?.images?.length
      ? activeColor.images
      : ["/placeholder.png"]

  const currentImage =
    activeImages[selectedImageIndex] || activeImages[0]

  const discountPercentage =
    product.originalPrice && product.originalPrice > product.price
      ? Math.round((1 - product.price / product.originalPrice) * 100)
      : null

  const goPrevImage = () => {
    setSelectedImageIndex((prev) =>
      prev === 0 ? activeImages.length - 1 : prev - 1
    )
  }

  const goNextImage = () => {
    setSelectedImageIndex((prev) =>
      prev === activeImages.length - 1 ? 0 : prev + 1
    )
  }

  const handleSelectColor = (index: number) => {
    setSelectedColorIndex(index)
    setSelectedImageIndex(0)
  }

  const handleAddToCart = () => {
    if (!onAddToCart || !activeColor?.name) return

    onAddToCart(
      product,
      activeColor.name,
      currentImage
    )
  }

  return (
    <article className="group overflow-hidden rounded-2xl border border-white/[0.07] bg-[#0A0A0A] transition-all duration-300 hover:border-white/[0.13] hover:shadow-xl hover:shadow-black/50">
      <ProductCardImage
        image={currentImage}
        canNavigate={activeImages.length > 1}
        onPrev={goPrevImage}
        onNext={goNextImage}
        productName={product.name}
        onOpenPreview={() =>
          onOpenPreview?.({
            ...product,
            initialColor: activeColor?.name,
          })
        }
      />

      {/* Zona de info — altura fija para que todas las cards alineen */}
      <div className="flex flex-col p-4 pt-3.5">

        {/* Categoría — altura fija */}
        <p className="h-4 text-[10px] font-semibold uppercase tracking-[0.22em] text-white/35 truncate">
          {product.category}
        </p>

        {/* Nombre — exactamente 2 líneas, siempre */}
        <h3
          className="mt-1.5 line-clamp-2 min-h-[2.75rem] text-[15px] font-semibold leading-[1.375rem] text-white cursor-pointer hover:text-white/80 transition-colors"
          onClick={() =>
            onOpenPreview?.({
              ...product,
              initialColor: activeColor?.name,
            })
          }
        >
          {product.name}
        </h3>

        {/* Colores — altura reservada aunque no haya colores */}
        <div className="mt-3 h-6 flex items-center">
          {product.colors?.length > 0 && (
            <ProductCardColors
              colors={product.colors}
              selectedIndex={selectedColorIndex}
              onSelectColor={handleSelectColor}
            />
          )}
        </div>

        {/* Precio + botón — siempre al fondo, alineado */}
        <div className="mt-3 pt-3 border-t border-white/[0.05]">
          <ProductCardPricing
            price={product.price}
            originalPrice={product.originalPrice}
            discountPercentage={discountPercentage}

            quantity={quantity}

            onAddToCart={handleAddToCart}

            onIncrease={() => {
              if (!activeColor?.name) return
              increaseQuantity(product.id, activeColor.name)
            }}

            onDecrease={() => {
              if (!activeColor?.name) return
              decreaseQuantity(product.id, activeColor.name)
            }}
          />
        </div>
      </div>
    </article>
  )
}