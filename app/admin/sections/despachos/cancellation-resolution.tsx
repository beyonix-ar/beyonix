"use client"

import { useRef, useState } from "react"
import { AlertTriangle, CheckCircle2, PackageX, XCircle } from "lucide-react"

import { AdminButton } from "@/app/admin/components/admin-controls"
import { orderCode, type CancellationResolutionResult, type DispatchHold } from "@/lib/admin/dispatch"
import { playScanFeedback } from "@/lib/admin/scan-feedback"
import { DispatchRequestError, dispatchRequest } from "./dispatch-request"
import { ScanField } from "./scan-field"

/**
 * Pedido cancelado después del primer pickeo (con o sin Bulto general). El
 * escaneo de su etiqueta Andreani (o, sin etiqueta todavía, de su número de
 * pedido) confirma el retiro físico: la base lo saca del Bulto general y
 * devuelve el stock exacto, una vez. El reintegro siempre es manual.
 */
export function CancellationResolution({ hold, onResolved, onClose }: {
  hold: DispatchHold
  onResolved?: (result: CancellationResolutionResult) => void
  onClose: () => void
}) {
  const [confirmed, setConfirmed] = useState(false)
  const [code, setCode] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [result, setResult] = useState<CancellationResolutionResult | null>(null)
  const requestKey = useRef<string | null>(null)
  const busyRef = useRef(false)

  async function resolve(scanned: string) {
    if (busyRef.current || !confirmed) return
    busyRef.current = true
    setBusy(true); setError("")
    requestKey.current ??= crypto.randomUUID()
    try {
      const response = await dispatchRequest<CancellationResolutionResult>("/resolutions", { code: scanned, requestKey: requestKey.current, orderId: hold.orderId })
      requestKey.current = null
      setResult(response); setCode("")
      playScanFeedback(response.alreadyResolved ? "warning" : "success")
      onResolved?.(response)
    } catch (cause) {
      // Sin respuesta: se reintenta con la misma clave (nunca devuelve stock dos veces).
      if (!(cause instanceof DispatchRequestError && cause.retryable)) { requestKey.current = null; setCode("") }
      setError(cause instanceof Error ? cause.message : "No se pudo confirmar el retiro.")
      playScanFeedback("error")
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const orderLabel = orderCode(hold.orderId)
  if (result) {
    return <div role="status" className="rounded-2xl border border-emerald-500/40 bg-emerald-950 p-4 sm:p-5">
      <p className="flex items-center gap-2 text-base font-black text-white"><CheckCircle2 className="size-5 text-emerald-300" />{result.alreadyResolved ? `${orderLabel} ya estaba resuelto` : `${orderLabel} retirado del despacho`}</p>
      <ul className="mt-3 space-y-1.5 text-sm text-white/80">
        <li>Stock liberado: <span className="font-black text-white">{result.units} {result.units === 1 ? "unidad" : "unidades"}</span>{result.alreadyResolved ? " (sin cambios: ya se había devuelto)" : ""}.</li>
        {result.batchCode && <li>Quitado del Bulto general <span className="font-mono font-bold text-white">{result.batchCode}</span>.</li>}
        <li className="font-bold text-amber-200">Reintegro manual requerido: nada vuelve automáticamente (tampoco el saldo a favor). Administración lo autoriza desde BEYONIX.</li>
      </ul>
      <AdminButton className="mt-4 h-12 w-full sm:w-auto" onClick={onClose}>Listo</AdminButton>
    </div>
  }

  return <div className="space-y-4">
    <div role="alert" className="rounded-2xl border border-red-500/45 bg-red-950 p-4 sm:p-5">
      <p className="flex items-center gap-2 text-base font-black text-white"><PackageX className="size-5 shrink-0 text-red-300" />Pedido {orderLabel} cancelado</p>
      <p className="mt-1 text-sm text-white/80">{hold.prepared ? "Este pedido ya fue preparado físicamente" : `Este pedido ya tenía ${hold.pickedUnits} de ${hold.units} unidades pickeadas`}{hold.batchCode ? <> y está dentro del Bulto general <span className="font-mono font-bold text-white">{hold.batchCode}</span></> : ""}. Requiere resolución física: el stock queda retenido hasta confirmar el retiro. El reintegro (incluido el saldo a favor) es manual: nunca automático.</p>
      <dl className="mt-3 grid grid-cols-2 gap-2 text-sm sm:max-w-md">
        <div className="rounded-xl bg-black/25 px-3 py-2"><dt className="text-10px font-black uppercase tracking-widest text-white/55">Pickeadas</dt><dd className="font-black tabular-nums text-white">{hold.pickedUnits} de {hold.units}</dd></div>
        <div className="rounded-xl bg-black/25 px-3 py-2"><dt className="text-10px font-black uppercase tracking-widest text-white/55">Escanear</dt><dd className="truncate font-bold text-white">{hold.prepared ? "Etiqueta Andreani" : orderLabel}</dd></div>
      </dl>
    </div>

    <ol className="space-y-2 text-sm text-white/80">
      <li className="flex gap-3"><span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-white/10 text-xs font-black text-white">1</span>{hold.prepared ? `Separá el pedido${hold.batchCode ? " y todos sus bultos del Bulto general" : " del circuito de despacho"}.` : "Juntá las unidades ya pickeadas del pedido y devolvelas a la estantería."}</li>
      <li className="flex gap-3"><span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-white/10 text-xs font-black text-white">2</span>{hold.prepared ? `Escaneá la etiqueta Andreani del pedido (si todavía no tenía, ingresá ${orderLabel}).` : `Identificá el pedido escaneando o ingresando ${orderLabel}.`}</li>
    </ol>

    <label className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 text-sm font-bold ${confirmed ? "border-emerald-500/45 bg-emerald-950/60 text-white" : "border-amber-500/45 bg-amber-950/50 text-amber-100"}`}>
      <input type="checkbox" className="mt-0.5 size-5 shrink-0" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
      <span>{hold.prepared ? `Confirmo que retiré físicamente el pedido ${orderLabel}${hold.batchCode ? ` del Bulto general ${hold.batchCode}` : ""}.` : `Confirmo que devolví a la estantería ${hold.pickedUnits === 1 ? "la unidad pickeada" : `las ${hold.pickedUnits} unidades pickeadas`} de ${orderLabel}.`}</span>
    </label>

    <ScanField label="Escanear pedido cancelado" placeholder={hold.prepared ? "Escaneá la etiqueta Andreani" : `Escaneá o ingresá ${orderLabel}`} submitLabel="Liberar stock"
      value={code} onChange={(value) => { setCode(value); requestKey.current = null }} onScan={(scanned) => void resolve(scanned)}
      busy={busy} disabled={!confirmed} inputDisabled={!confirmed} autoFocus={confirmed}
      cameraTitle={`Retirar ${orderLabel}`} cameraHint="Encuadrá la etiqueta Andreani del pedido" feedback={error ? { tone: "error", message: error } : null} />
    {!confirmed && <p className="flex items-center gap-2 text-xs font-bold text-amber-200"><AlertTriangle className="size-4" />Marcá la confirmación para habilitar el escaneo.</p>}
    {error && <p role="alert" className="flex items-center gap-2 text-sm font-bold text-red-300"><XCircle className="size-5 shrink-0" />{error}</p>}
    <AdminButton className="h-11 w-full sm:w-auto" onClick={onClose}>Volver</AdminButton>
  </div>
}
