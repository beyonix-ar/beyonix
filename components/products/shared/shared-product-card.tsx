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
      className="group cursor-pointer overflow-hidden rounded-2xl border border-white/8 bg-beyonix-surface transition-all duration-300 hover:border-beyonix-blue-light/30 hover:shadow-xl hover:shadow-black/50"
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

      <div className="flex flex-col p-5 pt-4">
        <p className="min-h-18px truncate text-11px font-semibold uppercase tracking-widest text-beyonix-cyan/80">
          {
            product.categorias
              ?.nombre
          }
        </p>

        <h3
          className="mt-2 min-h-48px line-clamp-2 text-16px font-semibold leading-product-title text-white transition-colors group-hover:text-white/88"
        >
          {product.nombre}
        </h3>

        <div className="mt-4 border-t border-white/6 pt-4">
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
