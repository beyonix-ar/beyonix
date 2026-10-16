"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { ADMIN_DISPATCH_CHANGED_EVENT } from "@/hooks/use-admin-notifications"
import { supabase } from "@/lib/supabase/client"
import { orderCode, type DispatchHold } from "@/lib/admin/dispatch"
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
  const notifications: AdminNotification[] = holds.map((hold) => ({
    id: `dispatch-hold:${hold.id}`,
    type: "shipping" as const,
    eventKey: `dispatch-hold:${hold.id}`,
    eventAt: hold.detectedAt,
    title: `Pedido ${orderCode(hold.orderId)} cancelado`,
    body: `${hold.prepared ? "Ya estaba preparado físicamente" : `Ya tenía ${hold.pickedUnits} de ${hold.units} unidades pickeadas`}${hold.batchCode ? ` y está en ${hold.batchCode}` : ""}. Requiere resolución física; el reintegro será manual.`,
    actionLabel: "Escanear pedido",
    actionUrl: `/admin/despachos?resolve=${hold.orderId}`,
    orderId: hold.orderId,
    isRead: false,
    priority: "attention" as const,
    kind: "action" as const,
  }))
  const active = batches.filter((batch) => batch.status !== "handed_over" && batch.blockedOrders.some((item) => !heldIds.has(item.orderId)))
  notifications.push(...active.flatMap((batch) => batch.blockedOrders.filter((item) => !heldIds.has(item.orderId)).map((item) => ({
    id: `dispatch:${batch.id}:${item.orderId}`,
    type: "shipping" as const,
    eventKey: `dispatch:${batch.id}:${item.orderId}`,
    eventAt: item.createdAt,
    title: `Pedido ${orderCode(item.orderId)} bloqueado`,
    body: `Está incluido en ${batch.code}. Retiralo antes del despacho. ${item.reason}.`,
    actionLabel: "Retirar del despacho",
    actionUrl: `/admin/despachos?batch=${batch.id}`,
    orderId: item.orderId,
    isRead: false,
    priority: "attention" as const,
    kind: "action" as const,
  }))))
  // Tanda cerrada sin bloqueados: UNA acción humana para toda la tanda. Con
  // bloqueados sólo se pide retirarlos (Despachos no permite confirmar).
  const readyToHandOver = batches.filter((batch) => batch.status === "closed" && batch.blockedOrders.length === 0)
  for (const batch of readyToHandOver) {
    const count = batch.orderCount ?? 0
    notifications.push({
      id: `dispatch-handover:${batch.id}`,
      type: "shipping",
      eventKey: `dispatch-handover:${batch.id}`,
      eventAt: batch.closed_at ?? batch.created_at ?? new Date(0).toISOString(),
      title: `Confirmar entrega de ${batch.code} a Andreani`,
      body: count === 1 ? "1 pedido listo para entregar al transporte." : `${count} pedidos listos para entregar al transporte.`,
      actionLabel: "Confirmar entrega",
      actionUrl: `/admin/despachos?batch=${batch.id}`,
      isRead: false,
      kind: "action",
    })
  }
  return { reviewCount: active.length, handoverCount: readyToHandOver.length, holdCount: holds.length, notifications }
}
