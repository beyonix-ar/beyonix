"use client"

import type {
  SupabaseProducto,
} from "@/lib/supabase/types"

import { useCart } from "@/context/cart-context"

import { ProductCardImage } from "./product-card-image"

import { ProductCardPricing } from "./product-card-pricing"
import {
  getDefaultVariantOption,
} from "@/lib/products/product-variants"
import { getInstallmentsLabel } from "@/lib/products/installments"

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

  const defaultVariant =
    getDefaultVariantOption(product)

  if (!defaultVariant) return null

  const image =
    defaultVariant.images[0]

  const quantity =
    getQuantity(
      product.id,
      defaultVariant.value
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
  const installmentsLabel =
    getInstallmentsLabel(product)

  const handleAddToCart = () => {
    onAddToCart?.(
      product,
      defaultVariant.value,
      image
    )
  }

  return (
    <article
      onClick={() =>
        onOpenPreview?.(
          product
        )
      }
      className="group flex h-full w-full cursor-pointer flex-col overflow-hidden rounded-2xl border border-white/8 bg-beyonix-surface shadow-lg shadow-black/15 transition-all duration-300 hover:-translate-y-0.5 hover:border-beyonix-blue-light/35 hover:shadow-2xl hover:shadow-black/35"
    >
      <ProductCardImage
        image={image}
        canNavigate={false}
        onPrev={() => {}}
        onNext={() => {}}
        productName={
          product.nombre
        }
      />

      <div className="flex flex-1 flex-col p-4">
        <p className="min-h-18px truncate text-10px font-semibold uppercase tracking-[0.16em] text-beyonix-cyan/75">
          {
            product.categorias
              ?.nombre
          }
        </p>

        <h3
          className="mt-1.5 min-h-44px line-clamp-2 text-15px font-semibold leading-product-title tracking-tight text-white transition-colors group-hover:text-white/90 sm:text-16px"
        >
          {product.nombre}
        </h3>

        <div className="mt-3 border-t border-white/7 pt-3">
          <ProductCardPricing
            price={product.precio}
            originalPrice={
              product.precio_anterior ||
              undefined
            }
            discountPercentage={
              discountPercentage
            }
            installmentsLabel={
              installmentsLabel
            }
            quantity={quantity}
            maxReached={
              defaultVariant.stock < 1 ||
              quantity >= defaultVariant.stock
            }
            onAddToCart={
              handleAddToCart
            }
            onIncrease={() =>
              increaseQuantity(
                product.id,
                defaultVariant.value
              )
            }
            onDecrease={() =>
              decreaseQuantity(
                product.id,
                defaultVariant.value
              )
            }
          />
        </div>
      </div>
    </article>
  )
}
