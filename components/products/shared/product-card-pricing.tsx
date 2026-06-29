"use client"

import { ProductCartToggleButton } from "@/components/products/product-cart-toggle-button"

interface ProductCardPricingProps {
  price?: number
  originalPrice?: number
  discountPercentage?: number | null
  installmentsLabel?: string | null

  quantity: number
  maxReached?: boolean

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
  maxReached = false,

  onAddToCart,
  onIncrease,
  onDecrease,
}: ProductCardPricingProps) {
  return (
    <div
      onClick={(e) =>
        e.stopPropagation()
      }
      className="flex h-full flex-col"
    >
      <div className="mb-3 flex min-h-84px items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <p className="text-20px font-semibold tracking-tight text-white tabular-nums sm:text-21px">
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

          {(!originalPrice ||
            originalPrice <=
              price) && (
            <div className="mt-1 min-h-18px" />
          )}

          {installmentsLabel && (
            <p className="mt-1.5 inline-flex rounded-full border border-beyonix-blue-light/20 bg-beyonix-blue/18 px-2 py-0.5 text-10px font-medium text-beyonix-cyan">
              {installmentsLabel}
            </p>
          )}

          {!installmentsLabel && (
            <div className="mt-1.5 min-h-22px" />
          )}
        </div>
      </div>

      <div className="mt-auto">
        <ProductCartToggleButton
          quantity={quantity}
          maxReached={maxReached}
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
    </div>
  )
}
