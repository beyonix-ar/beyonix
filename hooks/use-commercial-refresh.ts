"use client"

import { useEffect, useMemo, useRef } from "react"

import { useCart } from "@/context/cart-context"
import { refreshSiteSettings } from "@/hooks/use-site-settings"
import {
  COMMERCIAL_REFRESH_INTERVAL_MS,
  createCommercialRefreshRunner,
  getCommercialChangeCause,
  getCommercialUpdateNotice,
  type CommercialChangeSignals,
} from "@/lib/cart/cart-catalog-refresh"

export type CommercialRefreshResult = CommercialChangeSignals

/** Aviso al cliente según la causa detectada (null si no hubo cambio). */
export function getCommercialChangeNotice(result: CommercialRefreshResult): string | null {
  const cause = getCommercialChangeCause(result)
  return cause ? getCommercialUpdateNotice(cause, result.removedCount) : null
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

  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  const runRefresh = useMemo(
    () =>
      createCommercialRefreshRunner(
        async (): Promise<CommercialRefreshResult | null> => {
          try {
            const [cart, settings] = await Promise.all([
              refreshCartCatalog(),
              refreshSiteSettings(),
            ])
            const result: CommercialRefreshResult = {
              cartChanged: cart.changed,
              priceChanged: cart.priceChanged,
              availabilityChanged: cart.availabilityChanged,
              removedCount: cart.removedCount,
              settingsChanged: settings.changed,
              shippingSettingsChanged: settings.shippingChanged,
              otherSettingsChanged: settings.otherChanged,
            }
            if (result.cartChanged || result.settingsChanged) {
              onChangeRef.current(result)
            }
            return result
          } catch {
            // Sólo UX: un fallo de red no bloquea nada (Pagar revalida server-side).
            return null
          }
        },
        { isVisible: () => document.visibilityState === "visible" },
      ),
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
