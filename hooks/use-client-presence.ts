"use client"

import { useEffect, useMemo } from "react"

import { useAuth } from "@/context/auth-context"
import { useCart } from "@/context/cart-context"
import { supabase } from "@/lib/supabase/client"

function getCartPayload(cart: ReturnType<typeof useCart>["cart"]) {
  return cart.map((item) => ({
    product_id: item.product.id,
    name: item.product.nombre,
    quantity: item.quantity,
    price: item.product.precio,
    color: item.color,
    variant_id: item.variantId,
    variant_name: item.variantName,
    image: item.image,
  }))
}

export function useClientPresence() {
  const { user } = useAuth()
  const { cart, isReady } = useCart()
  const cartPayload = useMemo(() => getCartPayload(cart), [cart])

  useEffect(() => {
    if (!user?.id || user.rol !== "cliente") return

    const updatePresence = async () => {
      await supabase
        .from("client_presence")
        .upsert(
          {
            user_id: user.id,
            last_seen_at: new Date().toISOString(),
            current_path: window.location.pathname,
            user_agent: navigator.userAgent,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "user_id" }
        )
    }

    void updatePresence()
    const interval = window.setInterval(() => void updatePresence(), 60000)

    const handleVisibility = () => {
      if (document.visibilityState === "visible") void updatePresence()
    }

    document.addEventListener("visibilitychange", handleVisibility)

    return () => {
      window.clearInterval(interval)
      document.removeEventListener("visibilitychange", handleVisibility)
    }
  }, [user?.id, user?.rol])

  useEffect(() => {
    if (!user?.id || user.rol !== "cliente" || !isReady) return

    const saveCart = async () => {
      await supabase
        .from("client_carts")
        .upsert(
          {
            user_id: user.id,
            payload: cartPayload,
            updated_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          },
          { onConflict: "user_id" }
        )
    }

    void saveCart()
  }, [cartPayload, isReady, user?.id, user?.rol])
}
