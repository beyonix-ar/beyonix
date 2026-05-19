"use client"

import { ColorSelector } from "./color-selector"
import { ProductDescription } from "./product-description"
import { ProductPurchaseBox } from "./product-purchase-box"
import { ProductSpecs } from "./product-specs"
import {
  ProductItem,
  ProductVariant,
} from "./product-details"

interface ProductDetailsPanelProps {
  product: ProductItem
  selectedColor: string
  onColorChange: (colorName: string) => void
  onAddToCart: (quantity?: number) => void
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
  const details = product.details

  return (
    <aside className="flex h-full min-h-0 flex-col bg-[#0a0a0a] text-white">

      <div className="custom-scrollbar flex-1 overflow-y-auto overflow-x-hidden">

        <div className="sticky top-0 z-10 bg-[#0a0a0a] px-8 pt-8 pb-5 border-b border-white/[0.08]">
          <p className="mb-1.5 text-[10px] uppercase tracking-[0.3em] font-medium text-white/45">
            {product.category}
          </p>
          <h2 className="text-[22px] font-semibold leading-snug tracking-tight text-white">
            {product.name}
          </h2>
        </div>

        <div className="px-8 py-6 space-y-7">

          {details?.shortDescription && (
            <ProductDescription
              shortDescription={details.shortDescription}
              longDescription=""
              features={details.features}
            />
          )}

          <div>
            <p className="mb-3 text-[10px] uppercase tracking-[0.25em] font-medium text-white/45">
              Color seleccionado
            </p>
            <ColorSelector
              colors={product.colors.map(
                (color: ProductVariant) => ({
                  name: color.name,
                  value: color.value as never,
                })
              )}
              selectedColor={selectedColor}
              onSelect={onColorChange}
            />
          </div>

          {details?.specifications?.length ? (
            <ProductSpecs specifications={details.specifications} />
          ) : null}

        </div>
      </div>

      <div className="shrink-0 border-t border-white/[0.08]">
        <ProductPurchaseBox
          price={product.price}
          originalPrice={product.originalPrice}
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