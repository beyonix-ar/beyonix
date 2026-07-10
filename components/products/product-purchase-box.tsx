"use client"

import { useEffect, useState } from "react"
import { CreditCard } from "lucide-react"

import { ProductCartToggleButton } from "./product-cart-toggle-button"

interface ProductPurchaseBoxProps {
  price: number
  originalPrice?: number
  installmentsLabel?: string | null
  isInCart?: boolean
  cartQuantity?: number
  maxReached?: boolean
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
  maxReached = false,
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
    if (maxReached) return

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
    <div className="bg-[#070A0E] px-5 pb-5 pt-5 lg:px-8 lg:pb-6 lg:pt-6">
      <div className="mb-4 flex flex-wrap items-end gap-3 lg:mb-5">
        <span className="text-3xl font-black leading-none tracking-tight text-white lg:text-[34px]">
          {formatPrice(price)}
        </span>

        {discount && (
          <span className="rounded-lg border border-emerald-300/30 bg-emerald-400/16 px-2.5 py-1 text-13px font-bold leading-none text-emerald-200">
            -{discount}%
          </span>
        )}

        {originalPrice && originalPrice > price && (
          <span className="pb-0.5 text-15px leading-none text-white/48 line-through">
            {formatPrice(originalPrice)}
          </span>
        )}
      </div>

      {installmentsLabel && (
        <div className="mb-4 lg:mb-5">
          <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3.5 py-2 text-13px font-semibold text-white/70">
            <CreditCard className="size-3.5" />
            {installmentsLabel}
          </span>
        </div>
      )}

      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:gap-3">
        <div className="flex-1">
          <ProductCartToggleButton
            quantity={quantity}
            maxReached={maxReached}
            onAdd={handleAdd}
            onIncrease={handleIncrease}
            onDecrease={handleDecrease}
          />
        </div>

        <button
          type="button"
          aria-label="Ver carrito"
          onClick={onViewCart}
          className="flex h-12 w-full shrink-0 cursor-pointer items-center justify-center whitespace-nowrap rounded-xl border border-beyonix-blue-light/45 bg-[#112A43] px-5 text-14px font-bold text-white transition-all duration-200 hover:border-beyonix-blue-light/70 hover:bg-[#183B5E] hover:text-white active:scale-95 sm:w-auto lg:px-6"
        >
          Ver carrito
        </button>
      </div>
    </div>
  )
}
