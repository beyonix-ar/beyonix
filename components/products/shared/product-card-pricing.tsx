"use client"

import { ProductCartToggleButton } from "@/components/products/product-cart-toggle-button"

interface ProductCardPricingProps {
  price?: number
  originalPrice?: number
  discountPercentage?: number | null
  installmentsLabel?: string | null

  quantity: number

  onAddToCart?: () => void
  onIncrease?: () => void
  onDecrease?: () => void
}

const formatPrice = (
  value?: number
) =>
  `$${(value || 0).toLocaleString(
    "es-AR"
  )}`

export function ProductCardPricing({
  price = 0,
  originalPrice,
  discountPercentage,
  installmentsLabel,

  quantity,

  onAddToCart,
  onIncrease,
  onDecrease,
}: ProductCardPricingProps) {
  return (
    <div
      onClick={(e) =>
        e.stopPropagation()
      }
    >
      <div className="mb-4 flex items-end justify-between">
        <div>
          <div className="flex items-center gap-2">
            <p className="text-21px font-semibold tracking-tight text-white tabular-nums">
              {formatPrice(price)}
            </p>

            {!!discountPercentage && (
              <span className="rounded border border-green-500/20 bg-green-500/10 px-1.5 py-0.5 text-11px font-bold text-green-400">
                -
                {
                  discountPercentage
                }
                %
              </span>
            )}
          </div>

          {!!originalPrice &&
            originalPrice >
              price && (
              <p className="mt-1 text-xs text-white/42 line-through tabular-nums">
                {formatPrice(
                  originalPrice
                )}
              </p>
            )}

          {installmentsLabel && (
            <p className="mt-2 inline-flex rounded-full border border-beyonix-blue-light/20 bg-beyonix-blue/18 px-2.5 py-1 text-11px font-medium text-beyonix-cyan">
              {installmentsLabel}
            </p>
          )}
        </div>
      </div>

      <ProductCartToggleButton
        quantity={quantity}
        onAdd={
          onAddToCart ||
          (() => {})
        }
        onIncrease={
          onIncrease ||
          (() => {})
        }
        onDecrease={
          onDecrease ||
          (() => {})
        }
      />
    </div>
  )
}
