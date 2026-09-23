"use client"

import { useCallback, useState } from "react"

import { CartDrawer } from "./cart-drawer"
import { useCart } from "@/context/cart-context"
import { useCheckoutShippingPrefetch } from "@/hooks/use-checkout-shipping-prefetch"
import { useCommercialRefresh } from "@/hooks/use-commercial-refresh"
import { COMMERCIAL_UPDATE_NOTICE } from "@/lib/cart/cart-catalog-refresh"

export function CartWrapper() {
  const {
    cart,
    isOpen,
    closeCart,
    removeFromCart,
    updateQuantity,
  } = useCart()
  const [commercialUpdateNotice, setCommercialUpdateNotice] =
    useState<string | null>(null)

  // Con el carrito abierto, el cliente típicamente va camino a "Finalizar
  // compra": precargamos su cotización de envío en background para que
  // esté lista cuando llegue a /checkout (ver hook para el detalle).
  useCheckoutShippingPrefetch(isOpen)

  // Precios/stock/cuotas vigentes mientras el carrito está abierto (sólo UX).
  useCommercialRefresh({
    enabled: isOpen && cart.length > 0,
    onChange: useCallback(
      () => setCommercialUpdateNotice(COMMERCIAL_UPDATE_NOTICE),
      [],
    ),
  })

  return (
    <CartDrawer
      isOpen={isOpen}
      onClose={() => {
        setCommercialUpdateNotice(null)
        closeCart()
      }}
      items={cart}
      commercialUpdateNotice={commercialUpdateNotice}
      onDismissCommercialUpdateNotice={() => setCommercialUpdateNotice(null)}
      onRemoveItem={(productId, color) => {
        removeFromCart(productId, color)
      }}
      onUpdateQuantity={(productId, color, quantity) => {
        updateQuantity(productId, color, quantity)
      }}
    />
  )
}
