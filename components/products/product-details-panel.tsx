"use client"

import {
  BatteryCharging,
  Bluetooth,
  Cable,
  Clock,
  Headphones,
  Home,
  Mic,
  Music,
  Package,
  Radio,
  Shield,
  Star,
  Truck,
  Volume2,
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
}

const productFeatures = [
  {
    icon: Music,
    text: "Sonido estereo de alta fidelidad",
  },
  {
    icon: Volume2,
    text: "Graves profundos y claros",
  },
  {
    icon: Radio,
    text: "Aislamiento pasivo del ruido",
  },
  {
    icon: BatteryCharging,
    text: "Batería de larga duración",
  },
  {
    icon: Bluetooth,
    text: "Bluetooth 5.3",
  },
  {
    icon: Mic,
    text: "Microfono integrado",
  },
]

const iconMap: Record<string, LucideIcon> = {
  BatteryCharging,
  Bluetooth,
  Cable,
  Clock,
  Headphones,
  Home,
  Mic,
  Music,
  Package,
  Radio,
  Shield,
  Star,
  Truck,
  Volume2,
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
  const visibleFeatures =
    productSpecifications.length > 0
      ? productSpecifications.map((specification) => ({
          icon: iconMap[specification.icono] ?? Music,
          text: specification.texto,
        }))
      : productFeatures
  const limitedFeatures = visibleFeatures.slice(0, 10)
  const featureColumns =
    limitedFeatures.length >= 4
      ? [
          limitedFeatures.slice(0, Math.ceil(limitedFeatures.length / 2)),
          limitedFeatures.slice(Math.ceil(limitedFeatures.length / 2)),
        ]
      : [limitedFeatures]

  return (
    <aside className="flex min-h-0 flex-col bg-beyonix-surface text-white lg:h-full">
      <div className="flex min-h-0 flex-1 flex-col lg:overflow-hidden">
        {/* Header */}
        <div className="shrink-0 px-5 pb-4 pt-5 lg:px-8 lg:pb-5 lg:pt-8">
          <p className="mb-2 text-10px font-bold uppercase tracking-widest text-beyonix-sky">
            {product.categorias?.nombre}
          </p>

          <h2 className="text-2xl font-semibold leading-snug tracking-tight text-white lg:text-28px">
            {product.nombre}
          </h2>
        </div>

        <div className="h-px bg-white/8" />

        <div className="custom-scrollbar flex min-h-0 flex-1 flex-col lg:overflow-y-auto">
          <section className="shrink-0 border-b border-white/8 px-5 py-4 lg:px-8 lg:py-5">
            <p className="mb-3 text-10px font-bold uppercase tracking-widest text-white/40">
              Descripción
            </p>

            <div className="max-h-32 overflow-y-auto pr-2 text-white/72 lg:max-h-40">
              {product.descripcion && (
                <ProductDescription
                  shortDescription={product.descripcion}
                  longDescription=""
                  features={[]}
                />
              )}
            </div>
          </section>

          <section className="shrink-0 border-b border-white/8 px-5 py-4 lg:px-8 lg:py-5">
            <p className="mb-3 text-10px font-bold uppercase tracking-widest text-white/40">
              Especificaciones
            </p>

            <div className="pr-2">
              <div
                className={`grid items-start gap-4 ${
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
                          className="flex items-center gap-2.5 text-12px leading-5 text-white/70"
                        >
                          <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-beyonix-sky/20 bg-beyonix-blue/30 text-beyonix-sky">
                            <Icon className="size-3" />
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

          {hasVariants && (
            <section className="shrink-0 px-5 py-4 lg:px-8 lg:py-5">
              <p className="mb-2 text-10px font-bold uppercase tracking-widest text-white/40">
                Variante
              </p>

              <div>
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
              </div>
            </section>
          )}
        </div>
      </div>

      {/* Purchase footer */}
      <div className="shrink-0 border-t border-white/8 bg-beyonix-surface">
        <ProductPurchaseBox
          price={product.precio}
          originalPrice={product.precio_anterior || undefined}
          installmentsLabel={installmentsLabel}
          isInCart={isInCart}
          cartQuantity={cartQuantity}
          onAddToCart={onAddToCart}
          onDecreaseCart={onDecreaseCart}
          onRemoveFromCart={onRemoveFromCart}
          onViewCart={onViewCart}
        />
      </div>
    </aside>
  )
}
