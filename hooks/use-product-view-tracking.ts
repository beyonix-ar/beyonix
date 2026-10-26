"use client"

import { useEffect } from "react"

import type { ProductViewSource } from "@/lib/analytics/events"
import { sendProductView } from "@/lib/analytics/track-product-view"

type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number
  cancelIdleCallback?: (handle: number) => void
}

/**
 * Registra una vista cuando el producto queda visible. Se agenda en tiempo
 * ocioso (después del render y de la carga de imágenes críticas) y se cancela
 * si el producto deja de mostrarse antes; `productId` null = no medir.
 */
export function useProductViewTracking(productId: number | null, source: ProductViewSource) {
  useEffect(() => {
    if (productId == null) return

    const idleWindow = window as IdleWindow
    const run = () => void sendProductView(productId, source)

    if (idleWindow.requestIdleCallback && idleWindow.cancelIdleCallback) {
      const handle = idleWindow.requestIdleCallback(run, { timeout: 2_000 })
      return () => idleWindow.cancelIdleCallback?.(handle)
    }

    const timeout = window.setTimeout(run, 300)
    return () => window.clearTimeout(timeout)
  }, [productId, source])
}
