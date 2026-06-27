"use client"

import { useMemo, useState } from "react"
import { ShoppingBag } from "lucide-react"

import { Button } from "@/components/ui/button"

import { useCart } from "@/context/cart-context"

import { ProductImageCarousel } from "./product-image-carousel"
import { ColorSelector } from "../products/color-selector"
import {
  getDefaultVariantValue,
  getProductVariantOptions,
  getVariantOptionByValue,
} from "@/lib/products/product-variants"
import { getInstallmentsLabel } from "@/lib/products/installments"

import type { SupabaseProducto } from "@/lib/supabase/types"

interface CategoryProductCardProps {
  product: SupabaseProducto

  onOpenPreview: (
    product: SupabaseProducto & {
      selectedColor: string
    }
  ) => void
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

  const colors = useMemo(
    () => getProductVariantOptions(product),
    [product]
  )

  const [selectedColor, setSelectedColor] =
    useState(() =>
      getDefaultVariantValue(product)
    )

  const activeVariant = useMemo(
    () =>
      getVariantOptionByValue(
        product,
        selectedColor
      ),
    [product, selectedColor]
  )

  const images = activeVariant.images
  const installmentsLabel =
    getInstallmentsLabel(product)

  const handleAddToCart = () => {
    addToCart(
      product,
      selectedColor,
      images[0]
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
      <div className="pointer-events-none absolute -left-10 top-1/2 z-0 h-60 w-3 -translate-y-1/2 rounded-full bg-white/50 opacity-0 blur-3xl transition-all duration-500 group-hover:opacity-100" />

      <div className="pointer-events-none absolute -right-10 top-1/2 z-0 h-60 w-3 -translate-y-1/2 rounded-full bg-white/50 opacity-0 blur-3xl transition-all duration-500 group-hover:opacity-100" />

      <article className="relative z-10 flex h-full min-h-screen-small flex-col rounded-lg border border-border bg-card transition-all duration-500 hover:border-muted-foreground/30">
        <div className="relative h-280px overflow-hidden rounded-t-lg sm:h-320px">
          {/* Invisible accessible button sits behind the carousel arrows (z-5) but above the image */}
          <button
            type="button"
            aria-label={`Ver ${product.nombre}`}
            title={`Ver ${product.nombre}`}
            onClick={handleOpenPreview}
            className="absolute inset-0 z-5 cursor-pointer"
          />
          <ProductImageCarousel
            images={images}
            alt={product.nombre}
          />
        </div>

        <div className="flex flex-1 flex-col bg-beyonix-surface-3 px-4 pb-4 pt-3.5">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-13px uppercase tracking-wider text-muted-foreground">
              {product.categorias?.nombre}
            </p>

            <ColorSelector
              colors={colors.map((color) => ({
                name: color.name,
                value: color.value,
                colorHex: color.colorHex,
              }))}
              selectedColor={selectedColor}
              onSelect={setSelectedColor}
            />
          </div>

          <h3 className="mb-2.5 mt-2 min-h-44px line-clamp-2 text-15px font-bold leading-tight text-foreground sm:text-16px">
            {product.nombre}
          </h3>

          <div className="space-y-1">
            <span className="block text-18px font-bold text-foreground">
              {formatPrice(product.precio)}
            </span>

            {product.precio_anterior ? (
              <span className="mb-2 block min-h-28px text-14px line-through text-muted-foreground/70">
                {formatPrice(
                  product.precio_anterior
                )}
              </span>
            ) : (
              <div className="min-h-28px" />
            )}

            {installmentsLabel && (
              <span className="inline-flex rounded-full border border-beyonix-blue-light/20 bg-beyonix-blue/18 px-2.5 py-1 text-11px font-medium text-beyonix-cyan">
                {installmentsLabel}
              </span>
            )}

            {!installmentsLabel && (
              <div className="min-h-28px" />
            )}
          </div>

          <Button
            type="button"
            aria-label={`Añadir ${product.nombre} al carrito`}
            title={`Añadir ${product.nombre} al carrito`}
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
