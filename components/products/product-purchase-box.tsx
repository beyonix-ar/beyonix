"use client"

import { useEffect, useState } from "react"

import { ProductCartToggleButton } from "./product-cart-toggle-button"

interface ProductPurchaseBoxProps {
  price: number
  originalPrice?: number
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
    <div className="px-8 pb-7 pt-4">
      <div className="mb-4 flex items-baseline gap-2.5">
        <span className="text-28px font-bold leading-none tracking-tight text-white">
          {formatPrice(price)}
        </span>

        {discount && (
          <span className="rounded border border-emerald-500/25 bg-emerald-500/12 px-1.5 py-0.5 text-14px font-semibold leading-none text-emerald-400">
            -{discount}%
          </span>
        )}

        {originalPrice && originalPrice > price && (
          <span className="text-14px leading-none text-white/55 line-through">
            {formatPrice(originalPrice)}
          </span>
        )}
      </div>

      <div className="flex max-w-320px items-center gap-2">
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
          className="h-9 flex-1 cursor-pointer rounded-lg border border-white/15 bg-white/5 text-13px font-medium text-white/85 transition-colors hover:border-white/25 hover:bg-white/9 hover:text-white/85"
        >
          Ver carrito
        </button>
      </div>
    </div>
  )
}
