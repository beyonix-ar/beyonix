"use client"

import { useState, useEffect } from "react"
import { ProductCartToggleButton } from "./product-cart-toggle-button"

interface ProductPurchaseBoxProps {
  price: number
  originalPrice?: number
  isInCart?: boolean
  cartQuantity?: number        // ✅ cantidad real del carrito para este color
  onAddToCart: (quantity?: number) => void
  onDecreaseCart: () => void   // ✅ resta 1 unidad en el carrito
  onRemoveFromCart: () => void // elimina el item completamente
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
  // El estado local refleja siempre la cantidad real del carrito
  const [quantity, setQuantity] = useState(cartQuantity)

  // ✅ Sincroniza con el color seleccionado o cambios externos del carrito
  useEffect(() => {
    setQuantity(cartQuantity)
  }, [cartQuantity, isInCart])

  const handleAdd = () => {
    setQuantity(1)
    onAddToCart(1)
  }

  const handleIncrease = () => {
    setQuantity((q) => q + 1)
    onAddToCart(1)
  }

  const handleDecrease = () => {
    if (quantity <= 1) {
      // Si queda 1, eliminar del carrito completamente
      setQuantity(0)
      onRemoveFromCart()
    } else {
      // ✅ FIX: restar 1 sin eliminar el item
      setQuantity((q) => q - 1)
      onDecreaseCart()
    }
  }

  const discount =
    originalPrice && originalPrice > price
      ? Math.round(((originalPrice - price) / originalPrice) * 100)
      : null

  return (
    <div className="px-8 py-5">

      <div className="mb-4 flex items-baseline gap-2.5">
        <span className="text-22px font-bold tracking-tight text-white leading-none">
          {formatPrice(price)}
        </span>

        {discount && (
          <span className="text-14px font-semibold text-emerald-400 bg-emerald-500/12 border border-emerald-500/25 px-1.5 py-0.5 rounded leading-none">
            -{discount}%
          </span>
        )}

        {originalPrice && originalPrice > price && (
          <span className="text-14px text-white/75 line-through leading-none">
            {formatPrice(originalPrice)}
          </span>
        )}
      </div>

      <div className="space-y-2">
        <ProductCartToggleButton
          quantity={quantity}
          onAdd={handleAdd}
          onIncrease={handleIncrease}
          onDecrease={handleDecrease}
        />

        <button
          type="button"
          aria-label="Ver carrito"
          title="Ver carrito"
          onClick={onViewCart}
          className="w-full h-10 rounded-md border border-white/15 bg-white/5 text-14px font-medium text-white/85 transition-colors hover:bg-white/9 hover:text-white/85 hover:border-white/25 cursor-pointer"
        >
          Ver carrito
        </button>
      </div>
    </div>
  )
}