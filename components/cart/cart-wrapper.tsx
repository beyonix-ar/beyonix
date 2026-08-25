"use client"

import { CartDrawer } from "./cart-drawer"
import { useCart } from "@/context/cart-context"
import { useCheckoutShippingPrefetch } from "@/hooks/use-checkout-shipping-prefetch"

export function CartWrapper() {
  const {
    cart,
    isOpen,
    closeCart,
    removeFromCart,
    updateQuantity,
  } = useCart()

  // Con el carrito abierto, el cliente típicamente va camino a "Finalizar
  // compra": precargamos su cotización de envío en background para que
  // esté lista cuando llegue a /checkout (ver hook para el detalle).
  useCheckoutShippingPrefetch(isOpen)

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