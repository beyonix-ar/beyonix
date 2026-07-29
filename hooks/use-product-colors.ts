"use client"

import { useCallback, useEffect, useState } from "react"

import {
  getProductColorOptions,
  type ProductColorOption,
} from "@/lib/supabase/queries/productos"
import { supabase } from "@/lib/supabase/client"

export function useProductColors() {
  const [colors, setColors] = useState<ProductColorOption[]>([])

  const loadColors = useCallback(async () => {
    try {
      setColors(await getProductColorOptions())
    } catch (error) {
      console.error("No se pudieron cargar los colores de productos.", error)
    }
  }, [])

  useEffect(() => {
    void loadColors()

    let timer: ReturnType<typeof setTimeout> | null = null
    const scheduleReload = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        void loadColors()
      }, 180)
    }
    const channel = supabase
      .channel(`admin-product-colors-${Math.random().toString(36).slice(2)}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "producto_variantes" },
        scheduleReload,
      )
      .subscribe()
    const {
      data: { subscription: authSubscription },
    } = supabase.auth.onAuthStateChange((event) => {
      if (
        event === "INITIAL_SESSION" ||
        event === "SIGNED_IN" ||
        event === "TOKEN_REFRESHED"
      ) {
        scheduleReload()
      }
    })

    return () => {
      if (timer) clearTimeout(timer)
      authSubscription.unsubscribe()
      void supabase.removeChannel(channel)
    }
  }, [loadColors])

  return colors
}
