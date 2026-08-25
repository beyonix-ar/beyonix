"use client"

import { useEffect } from "react"

import { useAuth } from "@/context/auth-context"
import { useCart } from "@/context/cart-context"
import { prefetchCheckoutShippingQuote } from "@/lib/andreani/checkout-quote-client"

/**
 * Precarga la cotización de envío para la dirección guardada del usuario y
 * el carrito vigente, mientras el cliente todavía está revisando el
 * carrito — antes de que llegue a /checkout. Es la pieza que evita el
 * flash de "A definir": para cuando el checkout monta, la cotización ya
 * está resuelta y cacheada en `lib/andreani/checkout-quote-client`, que es
 * la misma caché que consulta el checkout.
 *
 * No hace nada si el usuario no está autenticado, no tiene dirección
 * completa guardada, o el carrito está vacío. Es seguro llamarlo más de
 * una vez (al abrir el carrito y de nuevo al hacer click en "Finalizar
 * compra"): la caché interna dedupea por destino+carrito.
 */
export function useCheckoutShippingPrefetch(active: boolean) {
  const { user } = useAuth()
  const { cart } = useCart()

  useEffect(() => {
    if (!active || !user) return

    void prefetchCheckoutShippingQuote({
      provincia: user.province,
      localidad: user.city,
      cpDestino: user.postalCode,
      items: cart,
    })
  }, [active, user, cart])
}
