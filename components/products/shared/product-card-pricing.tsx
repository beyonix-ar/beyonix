"use client"

import { ProductCartToggleButton } from "@/components/products/product-cart-toggle-button"

interface ProductCardPricingProps {
  price: number
  originalPrice?: number
  discountPercentage?: number | null

  quantity: number

  onAddToCart?: () => void
  onIncrease?: () => void
  onDecrease?: () => void
}

export function ProductCardPricing({
  price,
  originalPrice,
  discountPercentage,

  quantity,

  onAddToCart,
  onIncrease,
  onDecrease,
}: ProductCardPricingProps) {
  return (
    <div
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-end justify-between mb-3">
        <div>
          <div className="flex items-center gap-2">
            <p className="text-[18px] font-semibold tracking-tight text-white tabular-nums">
              ${price.toLocaleString("es-AR")}
            </p>

            {discountPercentage && (
              <span className="rounded bg-green-500/10 px-1.5 py-0.5 text-[11px] font-bold text-green-400 border border-green-500/20">
                -{discountPercentage}%
              </span>
            )}
          </div>

          {originalPrice && originalPrice > price && (
            <p className="mt-0.5 text-xs text-white/30 line-through tabular-nums">
              ${originalPrice.toLocaleString("es-AR")}
            </p>
          )}
        </div>
      </div>

      <ProductCartToggleButton
        quantity={quantity}
        onAdd={() => onAddToCart?.()}
        onIncrease={() => onIncrease?.()}
        onDecrease={() => onDecrease?.()}
      />
    </div>
  )
}