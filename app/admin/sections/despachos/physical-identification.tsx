"use client"

import { useRef, useState } from "react"
import { CheckCircle2, PenLine, Printer } from "lucide-react"

import { AdminButton, AdminModal, AdminPrimaryButton } from "@/app/admin/components/admin-controls"
import { LabelPrintDialog } from "@/app/admin/components/label-print-dialog"
import type { DispatchIdentificationMethod, OrderDispatchDetail } from "@/lib/admin/dispatch"
import { dispatchRequest } from "./dispatch-request"

const formatDateTime = (value: string | null | undefined) =>
  value ? new Intl.DateTimeFormat("es-AR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)) : "—"

/**
 * Identificación física obligatoria del pedido preparado antes del Bulto
 * general: etiqueta BX-PREP impresa y pegada o, si falla la impresora, el
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
  const [printed, setPrinted] = useState(false)
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

  const openPrint = () => { setPrinted(true); setDialog("print") }
  // Antes de imprimir, la acción principal es imprimir; después, confirmar que quedó pegada.

  return <section aria-label="Identificar pedido">
    {method ? <>
      <p role="status" className="flex items-start gap-2 text-sm font-bold text-emerald-200"><CheckCircle2 className="mt-0.5 size-4 shrink-0" /><span className="min-w-0"><span className="font-mono">{preparedCode}</span> · {method === "printed" ? "Etiqueta pegada" : "Código escrito a mano"} · {formatDateTime(identifiedAt)}</span></p>
      <AdminButton className="mt-2" size="sm" variant="ghost" icon={<Printer className="size-4" />} onClick={openPrint}>Reimprimir {preparedCode}</AdminButton>
    </> : <>
      <p className="text-xs text-white/75">Imprimí la etiqueta <span className="font-mono font-bold text-white">{preparedCode}</span>, pegala en el paquete y confirmá. Sin este paso el pedido no puede entrar al Bulto general.</p>
      <div className="mt-3 grid gap-2">
        <AdminButton variant={printed ? "secondary" : "primary"} className="h-12 w-full justify-center text-sm" icon={<Printer className="size-4" />} onClick={openPrint}>Imprimir etiqueta del pedido</AdminButton>
        <AdminButton variant={printed ? "primary" : "secondary"} className="h-12 w-full justify-center text-sm" icon={<CheckCircle2 className="size-4" />} disabled={busy || disabled} onClick={() => void confirm("printed")}>Confirmar etiqueta pegada</AdminButton>
      </div>
      <AdminButton className="mt-2 w-full" size="sm" variant="ghost" icon={<PenLine className="size-4" />} disabled={busy || disabled} onClick={() => { setWritten(false); setDialog("manual") }}>¿Sin impresora? Escribir a mano</AdminButton>
    </>}
    {error && dialog !== "manual" && <p role="alert" className="mt-2 text-sm font-bold text-red-300">{error}</p>}

    <AdminModal open={dialog === "manual"} compact title="Identificar a mano" description="Si no podés imprimir, escribí este código a mano, bien visible, en el paquete." onClose={() => setDialog(null)} footer={<div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
      <AdminButton className="h-11" onClick={() => setDialog(null)}>Cancelar</AdminButton>
      <AdminPrimaryButton className="h-11" disabled={busy || !written} onClick={() => void confirm("manual")}>Confirmar código escrito</AdminPrimaryButton>
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
