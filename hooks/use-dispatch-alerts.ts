"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { ADMIN_DISPATCH_CHANGED_EVENT } from "@/hooks/use-admin-notifications"
import { supabase } from "@/lib/supabase/client"
import { holdBundleLabel, orderCode, type DispatchHold } from "@/lib/admin/dispatch"
import type { AdminNotification } from "@/lib/admin/admin-notifications"

type BlockedBatch = {
  id: number
  code: string
  status: string
  created_at?: string
  closed_at?: string | null
  orderCount?: number
  blockedOrders: { orderId: number; reason: string; createdAt: string }[]
}

export function useDispatchAlerts(enabled: boolean) {
  const [batches, setBatches] = useState<BlockedBatch[]>([])
  const [holds, setHolds] = useState<DispatchHold[]>([])
  const requestId = useRef(0)

  const refresh = useCallback(async () => {
    const id = ++requestId.current
    if (!enabled) { setBatches([]); setHolds([]); return }
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) return
      const response = await fetch("/api/admin/dispatch?alerts=1", {
        headers: { Authorization: `Bearer ${session.access_token}` }, cache: "no-store",
      })
      if (!response.ok) return
      const data = await response.json() as { batches: BlockedBatch[]; holds?: DispatchHold[] }
      if (id === requestId.current) { setBatches(data.batches); setHolds(data.holds ?? []) }
    } catch { /* La siguiente señal o foco recupera el estado. */ }
  }, [enabled])

  useEffect(() => {
    const currentRequest = requestId
    void refresh()
    if (!enabled) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const schedule = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { timer = null; void refresh() }, 180)
    }
    const onFocus = () => { if (document.visibilityState === "visible") schedule() }
    const onDispatchChange = (event: Event) => {
      const table = "detail" in event ? event.detail : null
      if (typeof table === "string" && !["dispatch_blocks", "dispatch_batches", "dispatch_batch_items", "order_packages", "order_cancellation_holds"].includes(table)) return
      schedule()
    }
    window.addEventListener(ADMIN_DISPATCH_CHANGED_EVENT, onDispatchChange)
    window.addEventListener("focus", onFocus)
    document.addEventListener("visibilitychange", onFocus)
    return () => {
      currentRequest.current++
      if (timer) clearTimeout(timer)
      window.removeEventListener(ADMIN_DISPATCH_CHANGED_EVENT, onDispatchChange)
      window.removeEventListener("focus", onFocus)
      document.removeEventListener("visibilitychange", onFocus)
    }
  }, [enabled, refresh])

  const heldIds = new Set(holds.map((hold) => hold.orderId))
  // Cancelado después del armado: UNA alerta por pedido (aunque esté en un
  // lote), con la acción física que libera stock y reintegro.
  const notifications: AdminNotification[] = holds.map((hold) => {
    const bundle = holdBundleLabel(hold.batchCode)
    return {
      id: `dispatch-hold:${hold.id}`,
      type: "shipping" as const,
      eventKey: `dispatch-hold:${hold.id}`,
      eventAt: hold.detectedAt,
      title: bundle ? `Pedido cancelado en ${bundle}` : `Pedido ${orderCode(hold.orderId)} cancelado`,
      body: bundle
        ? `${orderCode(hold.orderId)} fue cancelado. Retiralo del ${bundle} antes de entregarlo.`
        : `${orderCode(hold.orderId)} fue cancelado con ${hold.prepared ? "el armado completo" : `${hold.pickedUnits} de ${hold.units} unidades pickeadas`}. Devolvé la mercadería al stock.`,
      actionLabel: bundle ? "Retirar del Bulto" : "Resolver mercadería",
      actionUrl: `/admin/despachos?resolve=${hold.orderId}`,
      orderId: hold.orderId,
      isRead: false,
      priority: "attention" as const,
      kind: "action" as const,
    }
  })
  const active = batches.filter((batch) => batch.status !== "handed_over" && batch.blockedOrders.some((item) => !heldIds.has(item.orderId)))
  notifications.push(...active.flatMap((batch) => batch.blockedOrders.filter((item) => !heldIds.has(item.orderId)).map((item) => ({
    id: `dispatch:${batch.id}:${item.orderId}`,
    type: "shipping" as const,
    eventKey: `dispatch:${batch.id}:${item.orderId}`,
    eventAt: item.createdAt,
    title: `Pedido ${orderCode(item.orderId)} por retirar`,
    body: `Está incluido en ${batch.code}. Retiralo para continuar.`,
    actionLabel: "Retirar pedido",
    actionUrl: `/admin/despachos?batch=${batch.id}`,
    orderId: item.orderId,
    isRead: false,
    priority: "attention" as const,
    kind: "action" as const,
  }))))
  return { reviewCount: active.length, holdCount: holds.length, notifications }
}
