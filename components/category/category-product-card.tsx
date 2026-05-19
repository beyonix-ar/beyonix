"use client"

import { useMemo, useState } from "react"
import { ShoppingBag } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ProductImageCarousel } from "./product-image-carousel"
import { ColorSelector } from "../products/color-selector"
import { useCart } from "@/context/cart-context"
import { StoreProduct } from "@/lib/types/product"

interface CategoryProductCardProps {
  product: StoreProduct
  onOpenPreview: (product: StoreProduct & { selectedColor: string }) => void
}

const formatPrice = (price: number) =>
  new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    minimumFractionDigits: 0,
  }).format(price)

export function CategoryProductCard({
  product,
  onOpenPreview,
}: CategoryProductCardProps) {
  const { addToCart } = useCart()

  const {
    id,
    name,
    category,
    price,
    originalPrice,
    colors,
    details,
    slug,
    categorySlug,
  } = product

  const [selectedColor, setSelectedColor] = useState(colors[0].name)

  const activeVariant = useMemo(
    () => colors.find((c) => c.name === selectedColor) ?? colors[0],
    [colors, selectedColor]
  )

  const images =
    activeVariant.images?.length > 0
      ? activeVariant.images
      : ["/placeholder.svg"]

  const handleAddToCart = () => {
    addToCart(
      {
        id,
        slug,
        name,
        price,
        originalPrice,
        category,
        categorySlug,
        colors,
      },
      selectedColor
    )
  }

  const handleOpenPreview = () => {
    onOpenPreview({
      ...product,
      selectedColor,
    })
  }

  return (
    <div className="group relative">
      <div className="pointer-events-none absolute top-1/2 -left-10 z-0 h-60 w-3 -translate-y-1/2 rounded-full bg-white/50 blur-3xl opacity-0 transition-all duration-500 group-hover:opacity-100" />
      <div className="pointer-events-none absolute top-1/2 -right-10 z-0 h-60 w-3 -translate-y-1/2 rounded-full bg-white/50 blur-3xl opacity-0 transition-all duration-500 group-hover:opacity-100" />

      <article className="relative z-10 flex h-full min-h-screen-small flex-col rounded-lg border border-border bg-card transition-all duration-500 hover:border-muted-foreground/30">
        
        {/* IMAGE */}
        <div
          className="relative z-10 h-320px cursor-pointer overflow-hidden rounded-t-lg"
          onClick={handleOpenPreview}
        >
          <ProductImageCarousel images={images} alt={name} />
        </div>

        <div className="flex flex-1 flex-col bg-[#111111] pt-4 px-4 pb-4">
          
          <div className="mb-2 flex items-center justify-between">
            <p className="text-13px uppercase tracking-wider text-muted-foreground">
              {category}
            </p>

            <div onClick={(e) => e.stopPropagation()}>
              <ColorSelector
                colors={colors.map((c) => ({
                  name: c.name,
                  value: c.value as never,
                }))}
                selectedColor={selectedColor}
                onSelect={setSelectedColor}
              />
            </div>
          </div>

          <h3 className="mt-2 mb-3 min-h-48px text-16px font-bold leading-tight text-foreground line-clamp-2">
            {name}
          </h3>

          <div className="space-y-1">
            <span className="block text-18px font-bold text-foreground">
              {formatPrice(price)}
            </span>

            {originalPrice ? (
              <span className="block min-h-28px mb-2 text-14px line-through text-muted-foreground/70">
                {formatPrice(originalPrice)}
              </span>
            ) : (
              <div className="min-h-28px" />
            )}
          </div>

          {/* BOTÓN */}
          <Button
            type="button"
            aria-label="Añadir al carrito"
            className="mt-auto w-full cursor-pointer"
            onClick={(e) => {
              e.stopPropagation()
              handleAddToCart()
            }}
          >
            <ShoppingBag className="mr-2 size-4" />
            Añadir al carrito
          </Button>
        </div>
      </article>
    </div>
  )
}