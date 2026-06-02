"use client"

import { useEffect, useState } from "react"

import { ProductCartToggleButton } from "./product-cart-toggle-button"

interface ProductPurchaseBoxProps {
  price: number
  originalPrice?: number
  installmentsLabel?: string | null
  isInCart?: boolean
  cartQuantity?: number
  onAddToCart: (quantity?: number) => void
  onDecreaseCart: () => void
  onRemoveFromCart: () => void
  onViewCart: () => void
}

function formatPrice(price: number) {
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    minimumFractionDigits: 0,
  }).format(price)
}

export function ProductPurchaseBox({
  price,
  originalPrice,
  installmentsLabel,
  isInCart = false,
  cartQuantity = 0,
  onAddToCart,
  onDecreaseCart,
  onRemoveFromCart,
  onViewCart,
}: ProductPurchaseBoxProps) {
  const [quantity, setQuantity] = useState(cartQuantity)

  useEffect(() => {
    setQuantity(cartQuantity)
  }, [cartQuantity, isInCart])

  const handleAdd = () => {
    setQuantity(1)
    onAddToCart(1)
  }

  const handleIncrease = () => {
    setQuantity((current) => current + 1)
    onAddToCart(1)
  }

  const handleDecrease = () => {
    if (quantity <= 1) {
      setQuantity(0)
      onRemoveFromCart()
      return
    }

    setQuantity((current) => current - 1)
    onDecreaseCart()
  }

  const discount =
    originalPrice && originalPrice > price
      ? Math.round(((originalPrice - price) / originalPrice) * 100)
      : null

  return (
    <div className="px-5 pb-5 pt-4 lg:px-8 lg:pb-7 lg:pt-5">
      {/* Price row */}
      <div className="mb-4 flex flex-wrap items-baseline gap-2.5 lg:mb-5 lg:gap-3">
        <span className="text-2xl font-bold leading-none tracking-tight text-white lg:text-26px">
          {formatPrice(price)}
        </span>

        {discount && (
          <span className="rounded border border-emerald-500/25 bg-emerald-500/12 px-2 py-0.5 text-13px font-semibold leading-none text-emerald-400">
            -{discount}%
          </span>
        )}

        {originalPrice && originalPrice > price && (
          <span className="text-14px leading-none text-white/45 line-through">
            {formatPrice(originalPrice)}
          </span>
        )}
      </div>

      {installmentsLabel && (
        <div className="mb-4 lg:mb-5">
          <span className="inline-flex rounded-full border border-beyonix-blue-light/20 bg-beyonix-blue/18 px-3 py-1.5 text-12px font-medium text-beyonix-cyan">
            {installmentsLabel}
          </span>
        </div>
      )}

      {/* Buttons row */}
      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:gap-3">
        <div className="flex-1">
          <ProductCartToggleButton
            quantity={quantity}
            onAdd={handleAdd}
            onIncrease={handleIncrease}
            onDecrease={handleDecrease}
          />
        </div>

        <button
          type="button"
          aria-label="Ver carrito"
          title="Ver carrito"
          onClick={onViewCart}
          className="flex h-11 w-full shrink-0 cursor-pointer items-center justify-center whitespace-nowrap rounded-lg border border-white/12 bg-black/45 px-5 text-13px font-medium text-white/85 transition-colors hover:border-beyonix-blue-light/45 hover:bg-white/7 hover:text-white active:scale-95 sm:w-auto lg:px-6"
        >
          Ver carrito
        </button>
      </div>
    </div>
  )
}
