"use client"

import { useEffect, useRef, useState } from "react"
import { CheckCircle2, Circle, Download, Printer } from "lucide-react"

import { AdminBadge, AdminButton, AdminCard, AdminModal, AdminPrimaryButton, AdminRowMenu, AdminTextInput } from "@/app/admin/components/admin-controls"
import { DISPATCH_HANDOVER_BLOCKED_MESSAGE, orderCode, type BatchDispatchDetail, type DispatchHold, type DispatchScanMethod, type DispatchVerificationResult } from "@/lib/admin/dispatch"
import { batchStepFacts, getNextDispatchStep, type DispatchNextStep } from "@/lib/admin/dispatch-next-step"
import { dispatchBatchName } from "@/lib/admin/dispatch-queue"
import { matchesDispatchBatch } from "@/lib/admin/dispatch-scan"
import { dispatchBatchControlUrl } from "@/lib/barcodes/labels-document"
import { playScanFeedback } from "@/lib/admin/scan-feedback"
import { printLabels, saveBatchLabelsPdf } from "@/lib/barcodes/print-labels"
import { DispatchRequestError, dispatchRequest } from "./dispatch-request"
import { ScanField } from "./scan-field"

type Feedback = { tone: "success" | "warning" | "error"; message: string }
type BundleResponse = BatchDispatchDetail & { verification?: DispatchVerificationResult | null }
type Dialog = { kind: "remove"; orderId: number }
const plural = (count: number) => `${count} ${count === 1 ? "pedido" : "pedidos"}`

/** Control físico del Bulto: la última etiqueta Andreani lo finaliza en la RPC. */
export function GeneralBundlePanel({ detail, holds, liveUpdating, boardError, onChange, onOpenResolution, onRefresh, onAdvance }: {
  detail: BatchDispatchDetail
  holds: readonly DispatchHold[]
  liveUpdating: boolean
  boardError: boolean
  onChange: (detail: BatchDispatchDetail) => void
  onOpenResolution: (hold: DispatchHold) => void
  onRefresh: () => void
  /** Tras la entrega confirmada por la base, abre el siguiente paso (la tabla actualizada). */
  onAdvance?: (step: DispatchNextStep) => void
}) {
  const { batch, items } = detail
  const [scan, setScan] = useState("")
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [confirmation, setConfirmation] = useState("")
  const [confirmFeedback, setConfirmFeedback] = useState<Feedback | null>(null)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const scanKey = useRef<string | null>(null)
  const busyRef = useRef(false)
  const autoFinalizeKey = useRef<string | null>(null)

  const blockedItems = items.filter((item) => item.blocked)
  const blocked = blockedItems.length > 0 || detail.blockedCount > 0
  const finalized = batch.status !== "open" && !detail.requiresRevalidation
  const canVerify = !blocked && (batch.status === "open" || detail.requiresRevalidation)
  const canEdit = batch.status !== "handed_over"
  const labelDetails = { displayName: dispatchBatchName(batch), orderCodes: items.map((item) => orderCode(item.order_id)),
    date: new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(batch.created_at)),
    url: typeof window === "undefined" ? "" : dispatchBatchControlUrl(window.location.origin, batch.id) }

  // Cubre un Bulto que quedó completo tras retirar un pedido o recargar la página.
  // La RPC de cierre vuelve a validar bloqueos, preparación y cada lectura.
  useEffect(() => {
    if (batch.status !== "open" || blocked || detail.expectedCount === 0 || detail.verifiedCount !== detail.expectedCount) return
    const key = `${batch.id}:${batch.verification_round ?? 1}`
    if (autoFinalizeKey.current === key) return
    autoFinalizeKey.current = key
    void dispatchRequest<BatchDispatchDetail>(`/batches/${batch.id}`, { action: "close" })
      .then((updated) => { onChange(updated); onRefresh() })
      .catch((cause: unknown) => { setError(cause instanceof Error ? cause.message : "No se pudo finalizar el Bulto.") })
  }, [batch.id, batch.status, batch.verification_round, blocked, detail.expectedCount, detail.verifiedCount, onChange, onRefresh])

  // La etiqueta de este Bulto registra su entrega interna (idempotente en la RPC); otro código no envía nada.
  function confirmBundle(code: string) {
    if (busyRef.current) return
    setConfirmation("")
    const reject = (message: string) => { setConfirmFeedback({ tone: "error", message }); playScanFeedback("error") }
    if (!matchesDispatchBatch(code, batch)) return reject("El código no corresponde a este Bulto.")
    void (async () => {
      busyRef.current = true
      setBusy(true); setError(""); setConfirmFeedback(null)
      try {
        const updated = await dispatchRequest<BatchDispatchDetail>(`/batches/${batch.id}`, { action: "handover", code })
        playScanFeedback("success")
        onChange(updated)
        onRefresh()
        // Con incidencias el paso es este mismo Bulto (sus pedidos a retirar): no se avanza.
        const step = getNextDispatchStep(batchStepFacts(updated))
        if (step.screen !== "batch" || step.batchId !== batch.id) onAdvance?.(step)
      } catch (cause) {
        reject(cause instanceof Error ? cause.message : "No se pudo confirmar la entrega del Bulto.")
        // Validación final en la base: el Bulto vuelve con TODOS los pedidos a retirar.
        const fresh = cause instanceof DispatchRequestError ? cause.payload?.detail : null
        if (fresh && typeof fresh === "object") { onChange(fresh as BatchDispatchDetail); onRefresh() }
      }
      finally { busyRef.current = false; setBusy(false) }
    })()
  }

  function report(next: Feedback) {
    setFeedback(next)
    playScanFeedback(next.tone)
  }

  async function run(action: () => Promise<void>) {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true); setError("")
    try { await action(); onRefresh() }
    catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo completar la operación.") }
    finally { busyRef.current = false; setBusy(false) }
  }

  async function verify(body: { code?: string; orderId?: number; method: DispatchScanMethod | "manual_selection" }, requestKey: string) {
    const updated = await dispatchRequest<BundleResponse>(`/batches/${batch.id}`, { action: "verify", requestKey, ...body })
    onChange(updated)
    const result = updated.verification
    if (result) report({ tone: result.duplicate ? "warning" : "success", message: result.duplicate
      ? `${orderCode(result.orderId)} ya estaba controlado.`
      : updated.batch.status === "closed" ? "Bulto finalizado." : `${orderCode(result.orderId)} controlado.` })
    return updated
  }

  function submitScan(code: string, method: DispatchScanMethod) {
    if (busyRef.current) return
    if (code !== scan.trim()) scanKey.current = null
    setScan(code)
    scanKey.current ??= crypto.randomUUID()
    const requestKey = scanKey.current
    void (async () => {
      busyRef.current = true
      setBusy(true); setError("")
      try {
        await verify({ code, method }, requestKey)
        setScan(""); scanKey.current = null
        onRefresh()
      } catch (cause) {
        if (!(cause instanceof DispatchRequestError && cause.retryable)) { setScan(""); scanKey.current = null }
        report({ tone: "error", message: cause instanceof Error ? cause.message : "No se pudo controlar el pedido." })
      } finally { busyRef.current = false; setBusy(false) }
    })()
  }

  return <section className="mx-auto w-full max-w-3xl min-w-0" aria-label={dispatchBatchName(batch)}>
    <AdminCard className="dispatch-card min-w-0 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="text-sm text-white/70">{plural(items.length)}</p>
        {!blocked && <AdminBadge tone={finalized ? "success" : "info"}>{finalized ? "Finalizado" : "En armado"}</AdminBadge>}
      </div>

      {blocked ? <div className="mt-4">
        <div role="alert" className="rounded-xl border border-red-500/45 bg-red-950 p-3">
          <p className="text-sm font-black text-white">{DISPATCH_HANDOVER_BLOCKED_MESSAGE}</p>
          <p className="mt-0.5 text-sm font-bold text-red-200">⚠ {blockedItems.length === 1 ? "1 pedido requiere atención" : `${blockedItems.length} pedidos requieren atención`}</p>
        </div>
        <ul className="mt-2 divide-y divide-white/10">{blockedItems.map((item) => {
          const hold = item.cancellationHold ? holds.find((entry) => entry.orderId === item.order_id) : undefined
          return <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span className="text-sm font-bold text-white">{orderCode(item.order_id)} — <span className="text-red-300">{item.cancelled || item.cancellationHold ? "Cancelado" : item.blockReason ?? "Incidencia"}</span></span>
            <AdminPrimaryButton className="h-10 w-full sm:w-auto" disabled={busy || (item.cancellationHold && !hold)} onClick={() => {
              if (hold) onOpenResolution(hold)
              else { setReason(""); setDialog({ kind: "remove", orderId: item.order_id }) }
            }}>Retirar del Bulto</AdminPrimaryButton>
          </li>
        })}</ul>
        {!blockedItems.length && <AdminButton onClick={onRefresh}>Actualizar</AdminButton>}
      </div> : <>
        <ul className="mt-3 divide-y divide-white/10" aria-label="Pedidos del Bulto">{items.map((item) => <li key={item.id} className="flex items-center gap-3 py-2 text-sm">
          {item.verified ? <CheckCircle2 className="size-4 shrink-0 text-emerald-300" aria-label="Controlado" /> : <Circle className="size-4 shrink-0 text-white/50" aria-label="Pendiente" />}
          <span className="flex-1 font-bold text-white">{orderCode(item.order_id)}</span>
          <span className={item.verified ? "text-emerald-300" : "text-white/70"}>{item.verified ? "✓" : "Pendiente"}</span>
          {canEdit && !item.verified && <AdminRowMenu ariaLabel={`Opciones de ${orderCode(item.order_id)}`} items={[
            { key: "remove", label: "Retirar pedido", onSelect: () => { setReason(""); setDialog({ kind: "remove", orderId: item.order_id }) } },
          ]} />}
        </li>)}</ul>
        <p className="mt-3 text-sm font-bold text-white">{detail.verificationRequired === false ? plural(detail.expectedCount) : `${detail.verifiedCount} de ${detail.expectedCount} pedidos`}{finalized ? " · Bulto finalizado ✓" : ""}</p>
        {finalized && items.length > 0 && <div className="mt-4 flex flex-wrap gap-2">
          <AdminPrimaryButton icon={<Printer className="size-4" />} disabled={busy} onClick={() => void run(() => printLabels([{ kind: "batch", code: batch.code, details: labelDetails }], "single"))}>Imprimir etiqueta</AdminPrimaryButton>
          <AdminButton icon={<Download className="size-4" />} disabled={busy} onClick={() => void run(() => saveBatchLabelsPdf([batch.code], "single", { [batch.code]: labelDetails }))}>Guardar PDF</AdminButton>
        </div>}
        {finalized && items.length > 0 && <div className="mt-3">
          <p role="status" className="mb-2 flex items-center gap-2 text-sm font-black text-emerald-300"><CheckCircle2 className="size-4 shrink-0" />Bulto listo para entregar</p>
          <ScanField label="Escanear o ingresar el QR del Bulto" placeholder="Escanear / escribir QR del Bulto" submitLabel="Confirmar"
            value={confirmation} onChange={setConfirmation} onScan={confirmBundle} busy={busy} autoFocus={dialog === null}
            cameraTitle={dispatchBatchName(batch)} cameraHint="QR de la etiqueta del Bulto" feedback={confirmFeedback} />
          {confirmFeedback && <p role={confirmFeedback.tone === "error" ? "alert" : "status"} className={`mt-2 text-sm font-bold ${confirmFeedback.tone === "error" ? "text-red-300" : "text-emerald-300"}`}>{confirmFeedback.message}</p>}
        </div>}
        {canVerify && <div className="mt-3"><ScanField label="Escanear o ingresar etiqueta Andreani" placeholder="Escanear / escribir etiqueta Andreani" submitLabel="Verificar"
          value={scan} onChange={(value) => { setScan(value); scanKey.current = null }} onScan={submitScan}
          busy={busy} autoFocus={dialog === null} cameraTitle={dispatchBatchName(batch)} cameraHint="Etiqueta Andreani" continuousCamera feedback={feedback} /></div>}
      </>}
      {feedback && !blocked && <p role="status" className={`mt-2 text-sm font-bold ${feedback.tone === "error" ? "text-red-300" : "text-emerald-300"}`}>{feedback.message}</p>}
      {error && <p role="alert" className="mt-2 text-sm text-red-300">{error}</p>}
      {boardError && !blocked && <p role="alert" className="mt-2 text-xs text-amber-300">No se pudo actualizar la vista. Reintentá antes de continuar.</p>}
      {liveUpdating && !blocked && <p role="status" className="mt-2 text-xs text-white/60">Actualizando…</p>}
    </AdminCard>

    <AdminModal open={dialog !== null} compact title="Retirar pedido"
      onClose={() => setDialog(null)} footer={<div className="flex justify-end gap-2">
        <AdminButton onClick={() => setDialog(null)}>Cancelar</AdminButton>
        <AdminPrimaryButton disabled={busy || reason.trim().length < 10} onClick={() => {
          if (dialog) void run(async () => { onChange(await dispatchRequest<BatchDispatchDetail>(`/batches/${batch.id}`, { action: "remove", orderId: dialog.orderId, reason })); setDialog(null) })
        }}>Confirmar</AdminPrimaryButton>
      </div>}>
      <AdminTextInput title="Motivo obligatorio" value={reason} onChange={setReason} placeholder="Ingresá un motivo (mínimo 10 caracteres)" />
    </AdminModal>
  </section>
}
