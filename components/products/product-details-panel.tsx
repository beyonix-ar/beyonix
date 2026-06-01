"use client"

import {
  BatteryCharging,
  Bluetooth,
  Mic,
  Music,
  Radio,
  Volume2,
} from "lucide-react"

import type { SupabaseProducto } from "@/lib/supabase/types"

import { ColorSelector } from "./color-selector"
import { ProductDescription } from "./product-description"
import { ProductPurchaseBox } from "./product-purchase-box"
import {
  DEFAULT_VARIANT_VALUE,
  getProductVariantOptions,
} from "@/lib/products/product-variants"

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
    text: "Bateria de larga duracion",
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
  const hasVariants =
    colors.length > 1 || colors[0]?.value !== DEFAULT_VARIANT_VALUE

  return (
    <aside className="flex h-full min-h-0 flex-col bg-beyonix-surface text-white">
      <div className="custom-scrollbar flex-1 overflow-x-hidden overflow-y-auto">
        <div className="px-8 pb-4 pt-8">
          <p className="mb-1.5 text-10px font-bold uppercase tracking-widest text-beyonix-sky">
            {product.categorias?.nombre}
          </p>

          <h2 className="text-28px font-semibold leading-snug tracking-tight text-white">
            {product.nombre}
          </h2>
        </div>

        <div className="space-y-5 px-8 pb-5">
          {product.descripcion && (
            <ProductDescription
              shortDescription={
                product.descripcion
              }
              longDescription=""
              features={[]}
            />
          )}

          <div className="h-px bg-white/8" />

          <section>
            <p className="mb-3 text-10px font-bold uppercase tracking-widest text-white/50">
              Especificaciones
            </p>

            <ul className="grid gap-2">
              {productFeatures.map((feature) => {
                const Icon = feature.icon

                return (
                  <li
                    key={feature.text}
                    className="flex items-center gap-2.5 text-13px leading-5 text-white/72"
                  >
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-beyonix-sky/20 bg-beyonix-blue/35 text-beyonix-sky">
                      <Icon className="size-3.5" />
                    </span>
                    <span>{feature.text}</span>
                  </li>
                )
              })}
            </ul>
          </section>

          {hasVariants && (
            <div>
              <p className="mb-3 text-10px font-bold uppercase tracking-widest text-white/50">
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
            </div>
          )}

        </div>
      </div>

      <div className="shrink-0 border-t border-white/8 bg-beyonix-surface">
        <ProductPurchaseBox
          price={product.precio}
          originalPrice={
            product.precio_anterior ||
            undefined
          }
          isInCart={isInCart}
          cartQuantity={
            cartQuantity
          }
          onAddToCart={
            onAddToCart
          }
          onDecreaseCart={
            onDecreaseCart
          }
          onRemoveFromCart={
            onRemoveFromCart
          }
          onViewCart={
            onViewCart
          }
        />
      </div>
    </aside>
  )
}
