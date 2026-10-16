"use client"

import { useRef, useState } from "react"
import { CheckCircle2, PenLine, Printer, Tag } from "lucide-react"

import { AdminBadge, AdminButton, AdminModal, AdminPrimaryButton } from "@/app/admin/components/admin-controls"
import { LabelPrintDialog } from "@/app/admin/components/label-print-dialog"
import type { DispatchIdentificationMethod, OrderDispatchDetail } from "@/lib/admin/dispatch"
import { dispatchRequest } from "./dispatch-request"

const formatDateTime = (value: string | null | undefined) =>
  value ? new Intl.DateTimeFormat("es-AR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)) : "—"

/**
 * Identificación física obligatoria del pedido preparado antes del Bulto
 * general: etiqueta BX-PREP impresa y colocada o, si falla la impresora, el
 * mismo código escrito a mano. Reimprimir conserva siempre el mismo BX-PREP.
 */
export function PhysicalIdentification({ orderId, orderCode, preparedCode, method, identifiedAt, units, parcelCount, disabled = false, onUpdated }: {
  orderId: number
  orderCode: string
  preparedCode: string
  method: DispatchIdentificationMethod | null
  identifiedAt: string | null
  units: number
  parcelCount: number | null
  disabled?: boolean
  onUpdated: (detail: OrderDispatchDetail) => void
}) {
  const [dialog, setDialog] = useState<"print" | "manual" | null>(null)
  const [written, setWritten] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const keys = useRef<Partial<Record<DispatchIdentificationMethod, string>>>({})
  const labels = [{ kind: "prepared" as const, code: preparedCode, orderCode, units, parcelCount }]

  async function confirm(next: DispatchIdentificationMethod) {
    if (busy) return
    setBusy(true); setError("")
    // Misma clave para reintentos de la misma confirmación (sin duplicar).
    keys.current[next] ??= crypto.randomUUID()
    try {
      onUpdated(await dispatchRequest<OrderDispatchDetail>(`/orders/${orderId}`, { action: "identify", method: next, code: preparedCode, requestKey: keys.current[next] }))
      keys.current = {}
      setDialog(null); setWritten(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo registrar la identificación.")
    } finally { setBusy(false) }
  }

  return <section aria-label="Identificación física" className={`rounded-xl border p-3 sm:p-4 ${method ? "border-emerald-500/35 bg-emerald-950" : "border-amber-500/45 bg-amber-950/60"}`}>
    <div className="flex items-start justify-between gap-3">
      <span className="min-w-0">
        <span className="block text-10px font-black uppercase tracking-widest text-white/60">Identificación física</span>
        <span className="block truncate font-mono text-lg font-black text-white">{preparedCode}</span>
        <span className="block text-xs text-white/70">Pedido {orderCode}</span>
      </span>
      <AdminBadge tone={method ? "success" : "warning"}>{method ? "Identificado" : "Pendiente"}</AdminBadge>
    </div>
    {method ? <>
      <p role="status" className="mt-2 flex items-start gap-2 text-sm font-bold text-emerald-200"><CheckCircle2 className="mt-0.5 size-4 shrink-0" />{method === "printed" ? "Etiqueta BX-PREP colocada" : "Identificación manual colocada"} · {formatDateTime(identifiedAt)}</p>
      <AdminButton className="mt-3 w-full sm:w-auto" size="sm" icon={<Printer className="size-4" />} onClick={() => setDialog("print")}>Reimprimir {preparedCode}</AdminButton>
    </> : <>
      <p className="mt-2 text-xs text-white/80">Imprimí la etiqueta y pegala en el paquete. Sin identificación el pedido no entra al Bulto general.</p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <AdminButton className="h-11" icon={<Printer className="size-4" />} onClick={() => setDialog("print")}>Imprimir etiqueta</AdminButton>
        <AdminPrimaryButton className="h-11" icon={<Tag className="size-4" />} disabled={busy || disabled} onClick={() => void confirm("printed")}>Etiqueta colocada</AdminPrimaryButton>
      </div>
      <AdminButton className="mt-2 w-full" size="sm" variant="ghost" icon={<PenLine className="size-4" />} disabled={busy || disabled} onClick={() => { setWritten(false); setDialog("manual") }}>¿Falla la impresora? Identificación manual</AdminButton>
    </>}
    {error && dialog !== "manual" && <p role="alert" className="mt-2 text-sm font-bold text-red-300">{error}</p>}

    <AdminModal open={dialog === "manual"} compact title="Identificación manual colocada" description="Si no podés imprimir, escribí este código a mano, bien visible, en el paquete." onClose={() => setDialog(null)} footer={<div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
      <AdminButton className="h-11" onClick={() => setDialog(null)}>Cancelar</AdminButton>
      <AdminPrimaryButton className="h-11" disabled={busy || !written} onClick={() => void confirm("manual")}>Confirmar identificación manual</AdminPrimaryButton>
    </div>}>
      <div className="rounded-xl border border-white/15 bg-black/30 p-4 text-center">
        <p className="text-xs font-bold text-white/70">Pedido {orderCode}</p>
        <p className="mt-1 break-all font-mono text-2xl font-black text-white sm:text-3xl">{preparedCode}</p>
      </div>
      <label className={`mt-3 flex cursor-pointer items-start gap-3 rounded-xl border p-3 text-sm font-bold ${written ? "border-emerald-500/45 bg-emerald-950/60 text-white" : "border-amber-500/45 bg-amber-950/50 text-amber-100"}`}>
        <input type="checkbox" className="mt-0.5 size-5 shrink-0" checked={written} onChange={(event) => setWritten(event.target.checked)} />
        <span>Confirmo que escribí {preparedCode} en el paquete del pedido {orderCode}.</span>
      </label>
      <p className="mt-2 text-xs text-white/60">Queda registrado quién lo confirmó, cuándo y que fue manual.</p>
      {error && <p role="alert" className="mt-2 text-sm font-bold text-red-300">{error}</p>}
    </AdminModal>
    <LabelPrintDialog open={dialog === "print"} title="Etiqueta del pedido preparado" description={`${orderCode} · ${preparedCode}`} labels={labels} onClose={() => setDialog(null)} />
  </section>
}
