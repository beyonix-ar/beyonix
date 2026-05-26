"use client"

import type { SupabaseProducto } from "@/lib/supabase/types"

import { ColorSelector } from "./color-selector"
import { ProductDescription } from "./product-description"
import { ProductPurchaseBox } from "./product-purchase-box"
import { ProductSpecs } from "./product-specs"

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
  const colors = [
    {
      name: "default",
      value: "default",
    },
  ]

  return (
    <aside className="flex h-full min-h-0 flex-col bg-[#0a0a0a] text-white">
      <div className="custom-scrollbar flex-1 overflow-x-hidden overflow-y-auto">
        <div className="sticky top-0 z-10 border-b border-white/[0.08] bg-[#0a0a0a] px-8 pb-5 pt-8">
          <p className="mb-1.5 text-[10px] font-medium uppercase tracking-[0.3em] text-white/45">
            {product.categorias?.nombre}
          </p>

          <h2 className="text-[22px] font-semibold leading-snug tracking-tight text-white">
            {product.nombre}
          </h2>
        </div>

        <div className="space-y-7 px-8 py-6">
          {product.descripcion && (
            <ProductDescription
              shortDescription={
                product.descripcion
              }
              longDescription=""
              features={[]}
            />
          )}

          <div>
            <p className="mb-3 text-[10px] font-medium uppercase tracking-[0.25em] text-white/45">
              Variante
            </p>

            <ColorSelector
              colors={colors.map(
                (color) => ({
                  name: color.name,
                  value:
                    color.value as never,
                })
              )}
              selectedColor={
                selectedColor
              }
              onSelect={
                onColorChange
              }
            />
          </div>

          <ProductSpecs
            specifications={[
              {
                label: "Stock",
                value:
                  String(
                    product.stock
                  ),
              },
            ]}
          />
        </div>
      </div>

      <div className="shrink-0 border-t border-white/[0.08]">
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