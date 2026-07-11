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
            <p className="text-20px font-bold tracking-tight text-white tabular-nums sm:text-21px">
              {formatPrice(price)}
            </p>
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

          <div className="mt-2 flex min-h-22px flex-wrap gap-1.5">
            {!!discountPercentage && (
              <span className="inline-flex min-h-24px items-center rounded-full border border-green-500/25 bg-green-500/12 px-3 py-1.5 text-12px font-semibold leading-none text-green-400">
                En oferta
              </span>
            )}

            {installmentsLabel && (
              <span className="inline-flex min-h-24px items-center rounded-full border border-beyonix-blue-light/24 bg-beyonix-blue/22 px-3 py-1.5 text-12px font-medium leading-none text-beyonix-sky">
                {installmentsLabel}
              </span>
            )}

            {!discountPercentage && !installmentsLabel && (
              <span className="inline-flex rounded-full border border-beyonix-blue-light/16 bg-white/4 px-2 py-0.5 text-10px font-medium text-white/54">
                Stock disponible
              </span>
            )}
          </div>
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
