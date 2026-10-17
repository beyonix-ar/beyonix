"use client"

import { useEffect, useRef, useState, type FormEvent } from "react"
import { CheckCircle2, Circle, Download, Printer } from "lucide-react"

import { AdminBadge, AdminButton, AdminCard, AdminModal, AdminPrimaryButton, AdminRowMenu, AdminTextInput, type AdminRowMenuAction } from "@/app/admin/components/admin-controls"
import { printLabels, saveBatchLabelsPdf } from "@/lib/barcodes/print-labels"
import { orderCode, type BatchDispatchDetail, type DispatchHold, type DispatchScanMethod, type DispatchVerificationResult } from "@/lib/admin/dispatch"
import { dispatchBatchName } from "@/lib/admin/dispatch-queue"
import { orderIdFromDispatchCode } from "@/lib/admin/dispatch-scan"
import { playScanFeedback } from "@/lib/admin/scan-feedback"
import { DispatchRequestError, dispatchRequest } from "./dispatch-request"
import { ScanField } from "./scan-field"

type Feedback = { tone: "success" | "warning" | "error"; message: string }
type BundleResponse = BatchDispatchDetail & { verification?: DispatchVerificationResult | null }
type Dialog = { kind: "remove"; orderId: number } | { kind: "add" } | { kind: "history" } | { kind: "reopen" }
type BatchEvent = { id: number; action: string; order_id: number | null; created_at: string; metadata?: { reason?: string } | null }

const eventNames: Record<string, string> = {
  created: "Bulto creado", order_added: "Pedido agregado", order_verified: "Pedido controlado",
  order_removed: "Pedido retirado", closed: "Bulto finalizado", revalidation_required: "Control pendiente",
  handed_over: "Entrega registrada", reopened: "Bulto reabierto",
}
const plural = (count: number) => `${count} ${count === 1 ? "pedido" : "pedidos"}`
const dateTime = (value: string) => new Intl.DateTimeFormat("es-AR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value))

/** Control físico del Bulto: la última etiqueta Andreani lo finaliza en la RPC. */
export function GeneralBundlePanel({ detail, holds, liveUpdating, boardError, canReopen = false, onChange, onOpenResolution, onRefresh }: {
  detail: BatchDispatchDetail
  holds: readonly DispatchHold[]
  liveUpdating: boolean
  boardError: boolean
  canReopen?: boolean
  onChange: (detail: BatchDispatchDetail) => void
  onOpenResolution: (hold: DispatchHold) => void
  onRefresh: () => void
}) {
  const { batch, items } = detail
  const [scan, setScan] = useState("")
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [reason, setReason] = useState("")
  const [addCode, setAddCode] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [history, setHistory] = useState<BatchEvent[]>([])
  const scanKey = useRef<string | null>(null)
  const busyRef = useRef(false)
  const autoFinalizeKey = useRef<string | null>(null)

  const blockedItems = items.filter((item) => item.blocked)
  const blocked = blockedItems.length > 0 || detail.blockedCount > 0
  const finalized = batch.status !== "open" && !detail.requiresRevalidation
  const canVerify = !blocked && (batch.status === "open" || detail.requiresRevalidation)
  const canEdit = batch.status !== "handed_over"

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

  function addOrder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const id = orderIdFromDispatchCode(addCode)
    if (!id) { setError("Ingresá un pedido como BX-1031."); return }
    void run(async () => { onChange(await dispatchRequest<BatchDispatchDetail>(`/batches/${batch.id}`, { action: "add", orderId: id })); setAddCode(""); setDialog(null) })
  }

  function openHistory() {
    setDialog({ kind: "history" })
    void run(async () => { setHistory(await dispatchRequest<BatchEvent[]>(`/batches/${batch.id}?events=1`)) })
  }

  function outputLabel(mode: "print" | "pdf") {
    void run(async () => {
      if (mode === "print") await printLabels([{ kind: "batch", code: batch.code }], "single")
      else await saveBatchLabelsPdf([batch.code], "single")
    })
  }

  const menu: AdminRowMenuAction[] = [
    { key: "history", label: "Ver historial", onSelect: openHistory },
    { key: "print", label: "Imprimir etiqueta del Bulto", icon: <Printer className="size-4" />, disabled: busy || !finalized, onSelect: () => outputLabel("print") },
    { key: "pdf", label: "Guardar PDF", icon: <Download className="size-4" />, disabled: busy || !finalized, onSelect: () => outputLabel("pdf") },
    ...(batch.status === "open" ? [{ key: "add", label: "Agregar pedido", onSelect: () => setDialog({ kind: "add" }) }] : []),
    ...(canReopen && batch.status === "closed" ? [{ key: "reopen", label: "Reabrir Bulto", onSelect: () => { setReason(""); setDialog({ kind: "reopen" }) } }] : []),
  ]

  return <section className="mx-auto w-full max-w-3xl min-w-0" aria-label={`Bulto ${dispatchBatchName(batch)}`}>
    <AdminCard className="dispatch-card min-w-0 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="text-sm text-white/70">{plural(items.length)}</p>
        {!blocked && <AdminBadge tone={finalized ? "success" : "info"}>{finalized ? "Finalizado" : "En armado"}</AdminBadge>}
      </div>

      {blocked ? <div className="mt-4">
        <p role="alert" className="text-sm font-bold text-red-300">{blockedItems.length === 1 ? "Sacá este pedido del Bulto para continuar." : `Hay ${blockedItems.length} pedidos que tenés que retirar.`}</p>
        <ul className="mt-2 divide-y divide-white/10">{blockedItems.map((item) => {
          const hold = item.cancellationHold ? holds.find((entry) => entry.orderId === item.order_id) : undefined
          return <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span className="text-sm font-bold text-white">{orderCode(item.order_id)} · <span className="text-red-300">{item.cancellationHold ? "Cancelado" : "Retirar"}</span></span>
            <AdminPrimaryButton className="h-10 w-full sm:w-auto" disabled={busy || (item.cancellationHold && !hold)} onClick={() => {
              if (hold) onOpenResolution(hold)
              else { setReason(""); setDialog({ kind: "remove", orderId: item.order_id }) }
            }}>Retirar pedido</AdminPrimaryButton>
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
        {canVerify && <div className="mt-3"><ScanField label="Escanear o ingresar etiqueta Andreani" placeholder="Escanear / escribir etiqueta Andreani" submitLabel="Verificar"
          value={scan} onChange={(value) => { setScan(value); scanKey.current = null }} onScan={submitScan}
          busy={busy} autoFocus={dialog === null} cameraTitle={dispatchBatchName(batch)} cameraHint="Etiqueta Andreani" continuousCamera feedback={feedback} /></div>}
        <div className="mt-3"><AdminRowMenu triggerLabel="Bulto" ariaLabel="Opciones del Bulto" items={menu} /></div>
      </>}
      {feedback && !blocked && <p role="status" className={`mt-2 text-sm font-bold ${feedback.tone === "error" ? "text-red-300" : "text-emerald-300"}`}>{feedback.message}</p>}
      {error && <p role="alert" className="mt-2 text-sm text-red-300">{error}</p>}
      {boardError && !blocked && <p role="alert" className="mt-2 text-xs text-amber-300">No se pudo actualizar la vista. Reintentá antes de continuar.</p>}
      {liveUpdating && !blocked && <p role="status" className="mt-2 text-xs text-white/60">Actualizando…</p>}
    </AdminCard>

    <AdminModal open={dialog !== null} compact title={dialog?.kind === "remove" ? "Retirar pedido" : dialog?.kind === "history" ? "Historial del Bulto" : dialog?.kind === "reopen" ? "Reabrir Bulto" : "Agregar pedido"}
      onClose={() => setDialog(null)} footer={dialog?.kind === "history" || dialog?.kind === "add" ? undefined : <div className="flex justify-end gap-2">
        <AdminButton onClick={() => setDialog(null)}>Cancelar</AdminButton>
        <AdminPrimaryButton disabled={busy || ((dialog?.kind === "remove" || dialog?.kind === "reopen") && reason.trim().length < 10)} onClick={() => {
          if (dialog?.kind === "remove") void run(async () => { onChange(await dispatchRequest<BatchDispatchDetail>(`/batches/${batch.id}`, { action: "remove", orderId: dialog.orderId, reason })); setDialog(null) })
          else if (dialog?.kind === "reopen") void run(async () => { onChange(await dispatchRequest<BatchDispatchDetail>(`/batches/${batch.id}`, { action: "reopen", reason })); setDialog(null) })
        }}>Confirmar</AdminPrimaryButton>
      </div>}>
      {(dialog?.kind === "remove" || dialog?.kind === "reopen") && <AdminTextInput title="Motivo obligatorio" value={reason} onChange={setReason} placeholder="Ingresá un motivo (mínimo 10 caracteres)" />}
      {dialog?.kind === "history" && <ul className="max-h-64 overflow-y-auto text-sm text-white/80">{history.map((event) => <li key={event.id} className="border-b border-white/10 py-2">{dateTime(event.created_at)} · {eventNames[event.action] ?? event.action}{event.order_id ? ` · ${orderCode(event.order_id)}` : ""}{event.metadata?.reason ? ` · ${event.metadata.reason}` : ""}</li>)}</ul>}
      {dialog?.kind === "add" && <form onSubmit={addOrder} className="flex flex-col gap-2 sm:flex-row"><div className="flex-1"><AdminTextInput title="Pedido" value={addCode} onChange={setAddCode} placeholder="BX-1031" /></div><AdminPrimaryButton type="submit" disabled={busy || !addCode.trim()}>Agregar</AdminPrimaryButton></form>}
    </AdminModal>
  </section>
}
