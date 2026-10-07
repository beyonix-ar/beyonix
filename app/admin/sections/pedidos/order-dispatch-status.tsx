"use client"

import { useEffect, useState } from "react"

import { AdminBadge } from "@/app/admin/components/admin-controls"
import { supabase } from "@/lib/supabase/client"
import { DISPATCH_STAGE_LABELS, type OrderDispatchDetail } from "@/lib/admin/dispatch"

type Status = Pick<OrderDispatchDetail, "order" | "package" | "membership" | "batch" | "stage">

export function OrderDispatchStatus({ orderId, onOpenArmado }: { orderId: number; onOpenArmado?: () => void }) {
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
  const label = status.batch && status.stage !== "handed_over" ? `${DISPATCH_STAGE_LABELS[status.stage]} · ${status.batch.code}` : DISPATCH_STAGE_LABELS[status.stage]
  return <div className="admin-order-shipping-card rounded-lg border p-3"><div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs font-bold text-[var(--beyonix-text-muted)]">Armado y despacho</span><AdminBadge tone={status.stage === "handed_over" ? "success" : "info"}>{label}</AdminBadge></div>{status.batch ? <a href={`/admin/despachos?batch=${status.batch.id}`} className="mt-2 inline-block text-xs font-bold text-beyonix-cyan underline">Abrir lote</a> : onOpenArmado ? <button type="button" onClick={onOpenArmado} className="mt-2 inline-block cursor-pointer text-xs font-bold text-beyonix-cyan underline">Armar pedido</button> : <a href={`/admin/despachos?order=${orderId}`} className="mt-2 inline-block text-xs font-bold text-beyonix-cyan underline">Armar pedido</a>}</div>
}
