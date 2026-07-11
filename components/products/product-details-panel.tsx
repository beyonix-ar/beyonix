"use client"

import {
  Music,
  Package,
  Shield,
  Sparkles,
  Star,
  Truck,
  Zap,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"

import type { SupabaseProducto } from "@/lib/supabase/types"

import { ColorSelector } from "./color-selector"
import { ProductDescription } from "./product-description"
import { ProductPurchaseBox } from "./product-purchase-box"
import {
  DEFAULT_VARIANT_VALUE,
  getProductVariantOptions,
} from "@/lib/products/product-variants"
import { getInstallmentsLabel } from "@/lib/products/installments"

interface ProductDetailsPanelProps {
  product: SupabaseProducto

  selectedColor: string

  onColorChange: (
    colorName: string
  ) => void

  onAddToCart: (
    quantity?: number
  ) => void

  onDecreaseCart: () => void

  onRemoveFromCart: () => void

  onViewCart: () => void

  isInCart?: boolean
  cartQuantity?: number
  selectedStock: number
}

const iconMap: Record<string, LucideIcon> = {
  Music,
  Package,
  Shield,
  Sparkles,
  Star,
  Truck,
  Zap,
}

export function ProductDetailsPanel({
  product,
  selectedColor,
  onColorChange,
  onAddToCart,
  onDecreaseCart,
  onRemoveFromCart,
  onViewCart,
  isInCart = false,
  cartQuantity = 0,
  selectedStock,
}: ProductDetailsPanelProps) {
  const colors = getProductVariantOptions(product)
  const installmentsLabel =
    getInstallmentsLabel(product)
  const hasVariants =
    colors.length > 1 || colors[0]?.value !== DEFAULT_VARIANT_VALUE
  const productSpecifications =
    product.producto_especificaciones
      ?.filter((specification) => specification.activo !== false)
      .sort((a, b) => {
        if (a.orden !== b.orden) return a.orden - b.orden
        return a.id - b.id
      }) ?? []
  const visibleFeatures = productSpecifications.map((specification) => ({
    icon: iconMap[specification.icono] ?? Sparkles,
    text: specification.texto,
  }))
  const limitedFeatures = visibleFeatures.slice(0, 8)
  const featureColumns =
    limitedFeatures.length >= 4
      ? [
          limitedFeatures.slice(0, Math.ceil(limitedFeatures.length / 2)),
          limitedFeatures.slice(Math.ceil(limitedFeatures.length / 2)),
        ]
      : [limitedFeatures]

  return (
    <aside className="flex min-h-0 flex-col bg-[#080B0F] text-white md:h-full">
      <div className="flex min-h-0 flex-1 flex-col md:overflow-hidden">
        <div className="shrink-0 px-5 pb-4 pt-6 md:px-7 md:pb-5 md:pt-7">
          {product.categorias?.nombre && (
            <span className="mb-3 inline-flex items-center gap-2 rounded-full border border-beyonix-blue-light/24 bg-beyonix-blue/18 px-3.5 py-1.5 text-11px font-bold uppercase tracking-widest text-beyonix-sky">
              <Sparkles className="size-3.5" />
              {product.categorias.nombre}
            </span>
          )}

          <h2 className="text-[28px] font-bold leading-tight text-white md:text-[34px]">
            {product.nombre}
          </h2>
        </div>

        <div className="h-px bg-beyonix-blue-light/16" />

        <div className="custom-scrollbar flex min-h-0 flex-1 flex-col md:overflow-y-auto">
          <section className="shrink-0 border-b border-beyonix-blue-light/12 px-5 py-4 md:px-7">
            <p className="mb-2 text-11px font-bold uppercase tracking-widest text-white/68">
              Descripción
            </p>

            <div className="product-description-scrollbar max-h-32 overflow-y-auto pr-3 text-white/82">
              {product.descripcion ? (
                <ProductDescription
                  shortDescription={product.descripcion}
                  longDescription=""
                  features={[]}
                />
              ) : (
                <p className="text-15px leading-6 text-white/68">
                  Producto seleccionado para una experiencia de compra simple y confiable.
                </p>
              )}
            </div>
          </section>

          {limitedFeatures.length > 0 && (
            <section className="shrink-0 border-b border-beyonix-blue-light/12 px-5 py-4 md:px-7">
              <p className="mb-3 text-11px font-bold uppercase tracking-widest text-white/68">
                Características principales
              </p>

              <div className="pr-2">
                <div
                  className={`grid items-start gap-x-4 gap-y-2.5 ${
                    featureColumns.length > 1 ? "sm:grid-cols-2" : "grid-cols-1"
                  }`}
                >
                  {featureColumns.map((column, columnIndex) => (
                    <ul
                      key={`feature-column-${columnIndex}`}
                      className="grid content-start gap-y-2.5 self-start"
                    >
                      {column.map((feature) => {
                        const Icon = feature.icon

                        return (
                          <li
                            key={feature.text}
                            className="flex items-center gap-2.5 text-14px leading-5 text-white/82"
                          >
                            <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-beyonix-sky/24 bg-[#0D1720] text-beyonix-sky/88">
                              <Icon className="size-3.5" />
                            </span>
                            <span className="leading-tight">{feature.text}</span>
                          </li>
                        )
                      })}
                    </ul>
                  ))}
                </div>
              </div>
            </section>
          )}

          {hasVariants && (
            <section className="shrink-0 border-b border-beyonix-blue-light/12 px-5 py-4 md:px-7">
              <p className="mb-3 text-11px font-bold uppercase tracking-widest text-white/68">
                Variante
              </p>

              <ColorSelector
                colors={colors.map((color) => ({
                  name: color.name,
                  value: color.value,
                  colorHex: color.colorHex,
                }))}
                selectedColor={selectedColor}
                onSelect={onColorChange}
                showLabels
              />
            </section>
          )}
        </div>
      </div>

      <div className="shrink-0 border-t border-beyonix-blue-light/16 bg-[#070A0E]">
        <ProductPurchaseBox
          price={product.precio}
          originalPrice={product.precio_anterior || undefined}
          installmentsLabel={installmentsLabel}
          isInCart={isInCart}
          cartQuantity={cartQuantity}
          maxReached={selectedStock < 1 || cartQuantity >= selectedStock}
          onAddToCart={onAddToCart}
          onDecreaseCart={onDecreaseCart}
          onRemoveFromCart={onRemoveFromCart}
          onViewCart={onViewCart}
        />
      </div>
    </aside>
  )
}
