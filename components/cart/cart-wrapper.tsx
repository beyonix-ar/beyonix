"use client"

import { CartDrawer } from "./cart-drawer"
import { useCart } from "@/context/cart-context"

export function CartWrapper() {
  const {
    cart,
    isOpen,
    closeCart,
    removeFromCart,
    updateQuantity,
  } = useCart()

  return (
    <CartDrawer
      isOpen={isOpen}
      onClose={closeCart}
      items={cart}
      onRemoveItem={(productId, color) => {
        removeFromCart(productId, color)
      }}
      onUpdateQuantity={(productId, color, quantity) => {
        updateQuantity(productId, color, quantity)
      }}
    />
  )
}