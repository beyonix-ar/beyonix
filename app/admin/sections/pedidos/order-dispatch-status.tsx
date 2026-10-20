"use client"

import { useEffect, useState } from "react"
import { Boxes } from "lucide-react"

import { AdminBadge } from "@/app/admin/components/admin-controls"
import { supabase } from "@/lib/supabase/client"
import { DISPATCH_STAGE_LABELS, type OrderDispatchDetail } from "@/lib/admin/dispatch"

type Status = Pick<OrderDispatchDetail, "order" | "package" | "membership" | "batch" | "stage">

/**
 * Etapa del pedido en Despachos (armado en depósito -> Bulto general ->
 * entrega a Andreani). Va en Envío, debajo del progreso del envío, porque es
 * lo que pasa físicamente antes de que el envío salga.
 */
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
  const actionClassName = "admin-order-shipping-refined-action inline-flex h-8 cursor-pointer items-center justify-center gap-2 rounded-lg border px-3 font-black transition-colors"
  return (
    <section className="admin-order-shipping-card admin-order-dispatch-card rounded-lg border p-3" data-order-dispatch-status>
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-beyonix-blue-500/50 bg-beyonix-blue-900 text-[var(--beyonix-text-primary)]">
            <Boxes className="size-3.5" />
          </span>
          <div className="min-w-0">
            <p className="text-9px font-bold uppercase tracking-widest text-[var(--beyonix-text-muted)]">Depósito</p>
            <h3 className="mt-0.5 text-sm font-black text-[var(--beyonix-text-primary)]">Armado y despacho</h3>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <AdminBadge tone={status.stage === "handed_over" ? "success" : "info"}>{label}</AdminBadge>
          {status.batch ? (
            <a href={`/admin/despachos?batch=${status.batch.id}`} className={actionClassName}>Abrir Bulto general</a>
          ) : onOpenArmado ? (
            <button type="button" onClick={onOpenArmado} className={actionClassName}>Armar pedido</button>
          ) : (
            <a href={`/admin/despachos?order=${orderId}`} className={actionClassName}>Armar pedido</a>
          )}
        </div>
      </div>
    </section>
  )
}
