"use client"

import { useEffect, useState } from "react"

import { isLocalDeliveryArrivingToday } from "@/lib/shipping/local-delivery-outcome"

/** Cada cuánto se reevalúa con la página abierta (el cambio de día se refleja a lo sumo con este retraso). */
export const LOCAL_DELIVERY_ARRIVES_TODAY_TICK_MS = 30_000

/**
 * "¡Llega hoy!" (Mis compras → Gestión del pedido). La hora parte de la del
 * servidor en la última carga y sigue corriendo mientras la página está
 * abierta: al cambiar el día en hora de BEYONIX el mensaje desaparece solo,
 * sin recargar ni cambiar de pestaña. Al volver a la pestaña se reevalúa de
 * inmediato (los navegadores demoran los timers en segundo plano).
 */
export function LocalDeliveryArrivesToday({ order, serverNow }: {
  order: Parameters<typeof isLocalDeliveryArrivingToday>[0]
  serverNow: string
}) {
  const serverMs = Date.parse(serverNow)
  const [clock, setClock] = useState<{ serverMs: number; nowMs: number } | null>(null)

  useEffect(() => {
    if (!Number.isFinite(serverMs)) return
    const skew = serverMs - Date.now()
    const update = () => setClock({ serverMs, nowMs: Date.now() + skew })
    const interval = window.setInterval(update, LOCAL_DELIVERY_ARRIVES_TODAY_TICK_MS)
    const onVisible = () => { if (document.visibilityState === "visible") update() }
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      window.clearInterval(interval)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [serverMs])

  const nowMs = clock?.serverMs === serverMs ? clock.nowMs : serverMs
  if (!isLocalDeliveryArrivingToday(order, nowMs)) return null
  return (
    <p className="mb-1 text-sm font-bold text-[var(--account-text-primary)]" data-local-delivery-arrives-today="">
      ¡Llega hoy!
    </p>
  )
}
