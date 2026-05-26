"use client"

import type {
  SupabaseProducto,
} from "@/lib/supabase/types"

import { useCart } from "@/context/cart-context"

import { ProductCardImage } from "./product-card-image"

import { ProductCardPricing } from "./product-card-pricing"

interface SharedProductCardProps {
  product: SupabaseProducto

  onOpenPreview?: (
    product: SupabaseProducto
  ) => void

  onAddToCart?: (
    product: SupabaseProducto,
    color: string,
    image?: string
  ) => void
}

export default function SharedProductCard({
  product,
  onOpenPreview,
  onAddToCart,
}: SharedProductCardProps) {
  const {
    getQuantity,
    increaseQuantity,
    decreaseQuantity,
  } = useCart()

  const image =
    product.imagen_principal ||
    product
      .imagenes_producto?.[0]
      ?.url ||
    "/placeholder.png"

  const quantity =
    getQuantity(
      product.id,
      "default"
    )

  const discountPercentage =
    product.precio_anterior &&
    product.precio_anterior >
      product.precio
      ? Math.round(
          (1 -
            product.precio /
              product.precio_anterior) *
            100
        )
      : null

  const handleAddToCart = () => {
    onAddToCart?.(
      product,
      "default",
      image
    )
  }

  return (
    <article className="group overflow-hidden rounded-2xl border border-white/7 bg-[#0A0A0A] transition-all duration-300 hover:border-white/13 hover:shadow-xl hover:shadow-black/50">
      <ProductCardImage
        image={image}
        canNavigate={false}
        onPrev={() => {}}
        onNext={() => {}}
        productName={
          product.nombre
        }
        onOpenPreview={() =>
          onOpenPreview?.(
            product
          )
        }
      />

      <div className="flex flex-col p-4 pt-3.5">
        <p className="h-4 truncate text-10px font-semibold uppercase tracking-[0.22em] text-white/35">
          {
            product.categorias
              ?.nombre
          }
        </p>

        <h3
          onClick={() =>
            onOpenPreview?.(
              product
            )
          }
          className="mt-1.5 min-h-44px cursor-pointer line-clamp-2 text-15px font-semibold leading-[1.375rem] text-white transition-colors hover:text-white/80"
        >
          {product.nombre}
        </h3>

        <div className="mt-3 border-t border-white/5 pt-3">
          <ProductCardPricing
            price={product.precio}
            originalPrice={
              product.precio_anterior ||
              undefined
            }
            discountPercentage={
              discountPercentage
            }
            quantity={quantity}
            onAddToCart={
              handleAddToCart
            }
            onIncrease={() =>
              increaseQuantity(
                product.id,
                "default"
              )
            }
            onDecrease={() =>
              decreaseQuantity(
                product.id,
                "default"
              )
            }
          />
        </div>
      </div>
    </article>
  )
}