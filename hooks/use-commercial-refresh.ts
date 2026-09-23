"use client"

import { useCallback, useEffect, useRef } from "react"

import { useCart } from "@/context/cart-context"
import { refreshSiteSettings } from "@/hooks/use-site-settings"
import {
  COMMERCIAL_REFRESH_INTERVAL_MS,
  shouldRunCommercialRefresh,
} from "@/lib/cart/cart-catalog-refresh"

export interface CommercialRefreshResult {
  cartChanged: boolean
  settingsChanged: boolean
  removedCount: number
}

/**
 * Mantiene carrito/checkout al día con cambios administrativos (precio,
 * stock, variantes, cuotas, fees, transferencia, envío) mientras están
 * abiertos: relee catálogo y configuración al montar, al volver el foco a la
 * pestaña y cada 30 s con la pestaña visible. Si algo cambió, avisa vía
 * `onChange` para mostrar el aviso -- nunca cambia un total en silencio.
 *
 * Polling liviano en vez de Supabase Realtime: el cliente puede ser
 * anónimo, `productos`/`site_settings` no están publicados para Realtime y
 * los cambios administrativos llegan por muchas vías (editor, masivo,
 * eventos). Es sólo UX: si falla, Pagar igual revalida todo server-side.
 */
export function useCommercialRefresh({
  enabled,
  onChange,
}: {
  enabled: boolean
  onChange: (result: CommercialRefreshResult) => void
}) {
  const { refreshCartCatalog } = useCart()
  const onChangeRef = useRef(onChange)
  const stateRef = useRef({ inFlight: false, lastRunAt: 0 })

  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  const runRefresh = useCallback(
    async (force = false) => {
      const state = stateRef.current
      const now = Date.now()
      if (
        !shouldRunCommercialRefresh({
          visible: document.visibilityState === "visible",
          inFlight: state.inFlight,
          lastRunAt: state.lastRunAt,
          now,
          force,
        })
      ) {
        return null
      }

      state.inFlight = true
      state.lastRunAt = now
      try {
        const [cart, settings] = await Promise.all([
          refreshCartCatalog(),
          refreshSiteSettings(),
        ])
        const result: CommercialRefreshResult = {
          cartChanged: cart.changed,
          settingsChanged: settings.changed,
          removedCount: cart.removedCount,
        }
        if (result.cartChanged || result.settingsChanged) {
          onChangeRef.current(result)
        }
        return result
      } catch {
        // Sólo UX: un fallo de red no bloquea nada (Pagar revalida server-side).
        return null
      } finally {
        state.inFlight = false
      }
    },
    [refreshCartCatalog],
  )

  useEffect(() => {
    if (!enabled) return

    void runRefresh()

    const interval = window.setInterval(() => {
      void runRefresh()
    }, COMMERCIAL_REFRESH_INTERVAL_MS)
    const handleVisible = () => {
      if (document.visibilityState === "visible") void runRefresh()
    }

    document.addEventListener("visibilitychange", handleVisible)
    window.addEventListener("focus", handleVisible)

    return () => {
      window.clearInterval(interval)
      document.removeEventListener("visibilitychange", handleVisible)
      window.removeEventListener("focus", handleVisible)
    }
  }, [enabled, runRefresh])

  return runRefresh
}
