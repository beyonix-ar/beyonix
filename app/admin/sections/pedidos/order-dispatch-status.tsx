"use client"

import { useEffect, useState } from "react"

import { AdminBadge } from "@/app/admin/components/admin-controls"
import { supabase } from "@/lib/supabase/client"
import type { DispatchBatch, DispatchMembership, DispatchOrder, DispatchPackage } from "@/lib/admin/dispatch"

type Status = { order: DispatchOrder; package: DispatchPackage | null; membership: DispatchMembership | null; batch: DispatchBatch | null }

export function OrderDispatchStatus({ orderId }: { orderId: number }) {
  const [status, setStatus] = useState<Status | null>(null)
  useEffect(() => {
    let active = true
    void (async () => {
      const { data } = await supabase.auth.getSession()
      if (!data.session) return
      const response = await fetch(`/api/admin/dispatch/orders/${orderId}`, { headers: { Authorization: `Bearer ${data.session.access_token}` }, cache: "no-store" })
      if (!response.ok || !active) return
      const result = await response.json() as Status
      if (active) setStatus(result)
    })()
    return () => { active = false }
  }, [orderId])
  if (!status) return null
  const label = status.order.andreani_handed_over_at ? "Entregado a Andreani" : status.batch ? `En tanda ${status.batch.code}` : status.package?.status === "prepared" ? "Preparado" : status.package ? "Preparando" : "Pendiente"
  return <div className="admin-order-shipping-card rounded-lg border p-3"><div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs font-bold text-[var(--beyonix-text-muted)]">Preparación</span><AdminBadge tone={status.order.andreani_handed_over_at ? "success" : "info"}>{label}</AdminBadge></div>{status.batch ? <a href={`/admin/despachos?batch=${status.batch.id}`} className="mt-2 inline-block text-xs font-bold text-beyonix-cyan underline">Abrir tanda</a> : <a href={`/admin/despachos?order=${orderId}`} className="mt-2 inline-block text-xs font-bold text-beyonix-cyan underline">Abrir preparación</a>}</div>
}
