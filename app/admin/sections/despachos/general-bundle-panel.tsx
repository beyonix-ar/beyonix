"use client"

import { useEffect, useRef, useState, type FormEvent } from "react"
import Link from "next/link"
import { AlertTriangle, CheckCircle2, Circle, Printer, Truck, XCircle } from "lucide-react"

import { AdminBadge, AdminButton, AdminCard, AdminEmptyState, AdminModal, AdminPrimaryButton, AdminTextInput } from "@/app/admin/components/admin-controls"
import { LabelPrintDialog } from "@/app/admin/components/label-print-dialog"
import { supabase } from "@/lib/supabase/client"
import { DISPATCH_VERIFICATION_METHOD_LABELS, orderCode, type BatchDispatchDetail, type DispatchBatchItem, type DispatchHold, type DispatchScanMethod, type DispatchVerificationResult } from "@/lib/admin/dispatch"
import { normalizeScannedCode, orderIdFromDispatchCode } from "@/lib/admin/dispatch-scan"
import { playScanFeedback } from "@/lib/admin/scan-feedback"
import { DispatchLabel } from "./dispatch-label"
import { DispatchProgress } from "./dispatch-progress"
import { DispatchRequestError, dispatchRequest } from "./dispatch-request"
import { ScanField } from "./scan-field"

type Feedback = { tone: "success" | "warning" | "error"; message: string }
type BundleResponse = BatchDispatchDetail & { verification?: DispatchVerificationResult | null; handover?: { duplicate: boolean } | null }
type Dialog = { kind: "remove"; orderId: number } | { kind: "confirm"; item: DispatchBatchItem } | { kind: "close" } | { kind: "handover"; code: string } | { kind: "label" }

const MAX_ISSUES = 5
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`
const dateTime = (value: string | null | undefined) =>
  value ? new Intl.DateTimeFormat("es-AR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)) : "—"

/**
 * Bulto general (dispatch_batches): pedidos ESPERADOS vs VERIFICADOS. Cada
 * pedido se verifica con su BX-PREP por lector, cámara, tipeo/pegado o una
 * confirmación manual explícita; todo pasa por la misma acción "verify".
 * Los errores se muestran y la lectura sigue disponible.
 */
export function GeneralBundlePanel({ detail, holds, liveUpdating, boardError, onChange, onOpenResolution, onRefresh }: {
  detail: BatchDispatchDetail
  holds: readonly DispatchHold[]
  liveUpdating: boolean
  boardError: boolean
  onChange: (detail: BatchDispatchDetail) => void
  onOpenResolution: (hold: DispatchHold) => void
  onRefresh: () => void
}) {
  const { batch, items } = detail
  const [scan, setScan] = useState("")
  const [handoverScan, setHandoverScan] = useState("")
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [issues, setIssues] = useState<Feedback[]>([])
  const [issueCount, setIssueCount] = useState(0)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [reason, setReason] = useState("")
  const [addCode, setAddCode] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [barcodeUrl, setBarcodeUrl] = useState<string | null>(null)
  const scanKey = useRef<string | null>(null)
  const confirmKey = useRef<{ orderId: number; key: string } | null>(null)
  const busyRef = useRef(false)

  const blocked = detail.blockedCount > 0 && batch.status !== "handed_over"
  const allVerified = items.length > 0 && detail.missingCount === 0
  const canVerify = batch.status === "open" || detail.requiresRevalidation
  const exitBlocked = blocked || detail.requiresRevalidation || liveUpdating || boardError

  useEffect(() => {
    if (batch.status === "open") { setBarcodeUrl(null); return }
    let cancelled = false
    let objectUrl: string | null = null
    void (async () => {
      try {
        const { data } = await supabase.auth.getSession()
        if (!data.session) return
        const response = await fetch(`/api/admin/dispatch/batches/${batch.id}/barcode`, { headers: { Authorization: `Bearer ${data.session.access_token}` }, cache: "no-store" })
        if (!response.ok) return
        objectUrl = URL.createObjectURL(await response.blob())
        if (!cancelled) setBarcodeUrl(objectUrl)
      } catch { /* El Bulto general sigue disponible aunque la vista previa no cargue. */ }
    })()
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); setBarcodeUrl(null) }
  }, [batch.id, batch.status])

  function report(next: Feedback) {
    setFeedback(next)
    playScanFeedback(next.tone)
    if (next.tone === "success") return
    setIssueCount((count) => count + 1)
    setIssues((current) => [next, ...current].slice(0, MAX_ISSUES))
  }

  async function run(action: () => Promise<void>) {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true); setError("")
    try { await action(); onRefresh() }
    catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo completar la operación.") }
    finally { busyRef.current = false; setBusy(false) }
  }

  // Misma acción para lector, cámara, tipeo/pegado y confirmación manual.
  async function verify(body: { code?: string; orderId?: number; method: DispatchScanMethod | "manual_selection" }, requestKey: string) {
    const updated = await dispatchRequest<BundleResponse>(`/batches/${batch.id}`, { action: "verify", requestKey, ...body })
    onChange(updated)
    const result = updated.verification
    if (result) report({ tone: result.duplicate ? "warning" : "success", message: `${result.duplicate ? `${orderCode(result.orderId)} ya estaba verificado` : `✓ ${orderCode(result.orderId)} verificado`} · ${result.verified} de ${result.expected} pedidos` })
  }

  function submitScan(code: string, method: DispatchScanMethod) {
    if (busyRef.current) return
    // Mismo código pendiente de reintento: misma clave. Otro código: clave nueva.
    if (code !== scan.trim()) scanKey.current = null
    setScan(code)
    scanKey.current ??= crypto.randomUUID()
    const requestKey = scanKey.current
    busyRef.current = true
    setBusy(true)
    void (async () => {
      try {
        await verify({ code, method }, requestKey)
        setScan(""); scanKey.current = null
        onRefresh()
      } catch (cause) {
        if (!(cause instanceof DispatchRequestError && cause.retryable)) { scanKey.current = null; setScan("") }
        report({ tone: "error", message: `${code}: ${cause instanceof Error ? cause.message : "No se pudo verificar el pedido."}` })
      } finally { busyRef.current = false; setBusy(false) }
    })()
  }

  function confirmManually(item: DispatchBatchItem) {
    if (confirmKey.current?.orderId !== item.order_id) confirmKey.current = { orderId: item.order_id, key: crypto.randomUUID() }
    const requestKey = confirmKey.current.key
    void run(async () => {
      try { await verify({ orderId: item.order_id, method: "manual_selection" }, requestKey); confirmKey.current = null; setDialog(null) }
      catch (cause) { if (!(cause instanceof DispatchRequestError && cause.retryable)) confirmKey.current = null; throw cause }
    })
  }

  function scanHandover(code: string) {
    const normalized = normalizeScannedCode(code)?.toUpperCase() ?? ""
    setHandoverScan("")
    if (normalized !== batch.code) { report({ tone: "error", message: "Ese código no corresponde a este Bulto general. Escaneá o ingresá su DSP." }); return }
    setFeedback(null)
    playScanFeedback("success")
    setDialog({ kind: "handover", code: normalized })
  }

  function addOrder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const id = orderIdFromDispatchCode(addCode)
    if (!id) { setError("Ingresá un pedido como BX-1031."); return }
    void run(async () => { onChange(await dispatchRequest<BatchDispatchDetail>(`/batches/${batch.id}`, { action: "add", orderId: id })); setAddCode("") })
  }

  function confirmDialog() {
    if (!dialog) return
    void run(async () => {
      if (dialog.kind === "remove") onChange(await dispatchRequest<BatchDispatchDetail>(`/batches/${batch.id}`, { action: "remove", orderId: dialog.orderId, reason }))
      else if (dialog.kind === "close") onChange(await dispatchRequest<BatchDispatchDetail>(`/batches/${batch.id}`, { action: "close" }))
      else if (dialog.kind === "handover") {
        const updated = await dispatchRequest<BundleResponse>(`/batches/${batch.id}`, { action: "handover", code: dialog.code })
        onChange(updated)
        setFeedback(updated.handover?.duplicate ? { tone: "warning", message: "Este Bulto general ya estaba registrado como entregado." } : { tone: "success", message: "✓ Bulto general entregado a Andreani" })
      }
      setDialog(null); setReason("")
    })
  }

  const statusLabel = batch.status === "handed_over" ? "Entregado a Andreani" : blocked ? "Requiere revisión" : detail.requiresRevalidation ? "Volver a validar" : batch.status === "open" ? "Abierto · verificando" : "Cerrado · listo para entregar"
  const statusTone = batch.status === "handed_over" ? "success" : blocked ? "danger" : detail.requiresRevalidation ? "warning" : batch.status === "open" ? "info" : "success"
  const counters = [
    { label: "Esperados", value: detail.expectedCount, tone: "text-white" },
    { label: "Verificados", value: detail.verifiedCount, tone: "text-emerald-300" },
    { label: "Faltantes", value: detail.missingCount, tone: detail.missingCount ? "text-amber-300" : "text-white" },
    { label: "Cancelados", value: detail.cancelledCount, tone: detail.cancelledCount ? "text-red-300" : "text-white" },
    { label: "Duplicados / errores", value: issueCount, tone: issueCount ? "text-amber-300" : "text-white" },
  ]
  const batchLabel = [{ kind: "batch" as const, code: batch.code, orderCount: items.length, parcelCount: detail.parcelCount, date: dateTime(batch.closed_at) }]
  const firstBlocked = items.find((item) => item.blocked)
  const dialogOpen = dialog !== null && dialog.kind !== "label"

  return <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,380px)] lg:items-start">
    <div className="min-w-0 space-y-3">
      <AdminCard className="dispatch-card p-3 sm:p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <span className="block text-10px font-black uppercase tracking-widest text-sky-200/70">Bulto general</span>
            <span className="block truncate font-mono text-lg font-black text-white">{batch.code}</span>
          </div>
          <AdminBadge tone={statusTone}>{statusLabel}</AdminBadge>
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5" aria-label="Control del Bulto general">
          {counters.map((counter) => <div key={counter.label} className="rounded-xl bg-black/25 px-3 py-2">
            <dt className="text-10px font-black uppercase tracking-widest text-white/55">{counter.label}</dt>
            <dd className={`text-xl font-black tabular-nums ${counter.tone}`}>{counter.value}</dd>
          </div>)}
        </dl>
        {batch.status !== "handed_over" && <DispatchProgress className="mt-3" done={detail.verifiedCount} total={detail.expectedCount} unit="pedidos verificados" />}
        {blocked && <p role="alert" className="mt-3 flex items-start gap-2 text-sm font-bold text-red-200"><AlertTriangle className="mt-0.5 size-4 shrink-0" />{plural(detail.blockedCount, "pedido requiere", "pedidos requieren")} revisión{firstBlocked ? ` (${orderCode(firstBlocked.order_id)})` : ""}. No se puede cerrar ni entregar hasta retirarlo físicamente.</p>}
        {detail.requiresRevalidation && !blocked && <p role="alert" className="mt-3 flex items-start gap-2 text-sm font-bold text-amber-200"><AlertTriangle className="mt-0.5 size-4 shrink-0" />La composición cambió: volvé a validar {plural(detail.missingCount, "pedido", "pedidos")} antes de entregar.</p>}
        {detail.verificationRequired === false && <p className="mt-3 text-xs text-white/60">Histórico: finalizado antes de la verificación por BX-PREP. Sólo figuran como verificados los pedidos con escaneos registrados.</p>}
        {batch.status === "handed_over" && <p role="status" className="mt-3 text-sm font-bold text-emerald-300">✓ Entregado a Andreani · {dateTime(batch.handed_over_at)}{detail.operatorName ? ` · ${detail.operatorName}` : ""}</p>}
      </AdminCard>
      {error && <div role="alert" className="rounded-xl border border-red-500/35 bg-red-950 p-3 text-sm text-white">{error}</div>}

      {items.length > 0 ? <ul className="space-y-2" aria-label="Pedidos del Bulto general">{items.map((item) => {
        const hold = item.cancellationHold ? holds.find((entry) => entry.orderId === item.order_id) : undefined
        const Icon = item.blocked ? XCircle : item.verified ? CheckCircle2 : Circle
        const legacy = !item.verified && detail.verificationRequired === false
        const badge = item.cancellationHold ? "Cancelado · retirar" : item.blocked ? "Requiere revisión" : item.verified ? "Verificado" : legacy ? "Sin verificación registrada" : "Pendiente"
        return <li key={item.id}><AdminCard data-dispatch-blocked={item.blocked ? "true" : undefined} data-verified={item.verified ? "true" : undefined} className={`dispatch-card flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between ${item.blocked ? "border-red-500/50 bg-red-950" : item.verified ? "border-emerald-500/35" : ""}`}>
          <div className="flex min-w-0 items-start gap-2.5">
            <Icon aria-hidden="true" className={`mt-0.5 size-5 shrink-0 ${item.blocked ? "text-red-300" : item.verified ? "text-emerald-300" : "text-white/40"}`} />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Link href={`/admin/pedidos/${item.order_id}`} className="font-black tabular-nums text-white underline">{orderCode(item.order_id)}</Link>
                <AdminBadge tone={item.blocked ? "danger" : item.verified ? "success" : legacy ? "neutral" : "warning"}>{badge}</AdminBadge>
              </div>
              <p className="mt-1 break-all text-xs text-white/65"><span className="font-mono">{item.preparedCode}</span>{item.verified && item.verificationMethod ? ` · ${DISPATCH_VERIFICATION_METHOD_LABELS[item.verificationMethod]}` : ""}{item.parcelCount ? ` · ${plural(item.parcelCount, "paquete", "paquetes")}` : ""}</p>
              {item.blocked && <p role="alert" className="mt-1 text-xs font-bold text-white">{item.cancellationHold ? `${orderCode(item.order_id)} fue cancelado y está dentro de este Bulto general: retiralo y escanealo.` : `Pedido bloqueado · ${item.blockReason ?? "Revisión requerida"}`}</p>}
            </div>
          </div>
          {batch.status !== "handed_over" && <div className="flex shrink-0 flex-wrap gap-2 sm:justify-end">
            {item.cancellationHold
              ? <AdminPrimaryButton className="h-11 w-full sm:w-auto" disabled={!hold} onClick={() => hold && onOpenResolution(hold)}>Escanear para retirar</AdminPrimaryButton>
              : <>
                {!item.verified && !item.blocked && canVerify && <AdminButton size="sm" className="h-10" disabled={busy} onClick={() => setDialog({ kind: "confirm", item })}>Confirmar</AdminButton>}
                <AdminButton size="sm" variant="ghost" className="h-10" disabled={busy} onClick={() => { setReason(""); setDialog({ kind: "remove", orderId: item.order_id }) }}>Retirar</AdminButton>
              </>}
          </div>}
        </AdminCard></li>
      })}</ul> : <AdminEmptyState title="El Bulto general no tiene pedidos" description="Agregá pedidos listos desde la cola o por número." />}
    </div>

    <div className={`space-y-3 lg:sticky lg:top-4 ${canVerify ? "dispatch-action-bar" : ""}`}>
      {canVerify && <AdminCard className="dispatch-card space-y-3 p-3 sm:p-4">
        <p className="text-sm font-bold text-white">Verificá cada pedido con su BX-PREP.</p>
        <ScanField label="Escanear o ingresar BX-PREP" placeholder="BX-PREP-…" submitLabel="Verificar"
          value={scan} onChange={(value) => { setScan(value); scanKey.current = null }} onScan={submitScan}
          busy={busy} autoFocus={dialog === null} cameraTitle={`Bulto general ${batch.code}`} cameraHint="Encuadrá la etiqueta BX-PREP del pedido" continuousCamera feedback={feedback} />
        {feedback && <FeedbackLine feedback={feedback} />}
        {issues.length > 0 && <div className="rounded-xl border border-white/10 bg-black/20 p-2.5">
          <p className="text-10px font-black uppercase tracking-widest text-white/55">Duplicados / errores</p>
          <ul className="mt-1 space-y-1 text-xs text-white/80">{issues.map((issue, index) => <li key={`${index}-${issue.message}`} className={issue.tone === "error" ? "text-red-200" : "text-amber-200"}>{issue.message}</li>)}</ul>
        </div>}
        {batch.status === "open" && <>
          <AdminPrimaryButton className="h-12 w-full text-base" disabled={busy || liveUpdating || !allVerified || blocked} onClick={() => setDialog({ kind: "close" })}>CERRAR BULTO GENERAL</AdminPrimaryButton>
          {!allVerified && items.length > 0 && <p className="text-xs text-amber-300">Faltan {plural(detail.missingCount, "pedido", "pedidos")} por verificar para cerrar.</p>}
          <details className="text-sm text-white/70"><summary className="cursor-pointer">Agregar pedido por número</summary><form onSubmit={addOrder} className="mt-2 flex flex-col gap-2"><AdminTextInput title="Agregar pedido" value={addCode} onChange={setAddCode} placeholder="BX-1031" /><AdminButton type="submit" disabled={busy || !addCode.trim()}>Agregar pedido</AdminButton></form></details>
        </>}
      </AdminCard>}
      {batch.status !== "open" && <AdminCard className="dispatch-card space-y-3 p-3 sm:p-4">
        <DispatchLabel batch={batch} orderCount={items.length} parcelCount={detail.parcelCount} barcodeUrl={barcodeUrl} />
        <AdminButton className="w-full" icon={<Printer className="size-4" />} onClick={() => setDialog({ kind: "label" })}>Imprimir etiqueta DSP</AdminButton>
      </AdminCard>}
      {batch.status === "closed" && <AdminCard className="dispatch-card space-y-3 p-3 sm:p-4">
        <p className="flex items-center gap-2 text-sm font-black text-white"><Truck className="size-5 text-beyonix-sky" />Entrega a Andreani</p>
        <p className="text-xs text-white/70">Llevá el Bulto general a la puerta y escaneá o ingresá su DSP justo antes de entregarlo. Cerrado no es lo mismo que entregado.</p>
        <ScanField label="Escanear o ingresar DSP" placeholder={`Escaneá ${batch.code}`} submitLabel="Verificar DSP"
          value={handoverScan} onChange={setHandoverScan} onScan={scanHandover}
          busy={busy} disabled={exitBlocked} cameraTitle={`Entrega de ${batch.code}`} cameraHint="Encuadrá la etiqueta DSP" feedback={feedback} />
        {!canVerify && feedback && <FeedbackLine feedback={feedback} />}
        {blocked && firstBlocked && <p role="alert" className="text-sm text-amber-300">{orderCode(firstBlocked.order_id)} requiere revisión antes de la entrega.</p>}
        {detail.requiresRevalidation && !blocked && <p role="alert" className="text-sm text-amber-300">Volvé a validar los pedidos antes de la entrega.</p>}
      </AdminCard>}
      {batch.status === "handed_over" && feedback && <FeedbackLine feedback={feedback} />}
    </div>

    <AdminModal open={dialogOpen && !(blocked && (dialog?.kind === "close" || dialog?.kind === "handover"))} compact
      title={dialog?.kind === "remove" ? "Retirar pedido del Bulto general" : dialog?.kind === "confirm" ? "Confirmar pedido manualmente" : dialog?.kind === "close" ? "CERRAR BULTO GENERAL" : "Confirmar entrega a Andreani"}
      description={dialog?.kind === "handover" ? `Ingresaste ${dialog.code}. ¿Confirmás que el Bulto general salió físicamente hacia Andreani? Pedidos: ${items.length} / Paquetes: ${detail.parcelCount}.`
        : dialog?.kind === "close" ? `${batch.code} · ${detail.verifiedCount} de ${detail.expectedCount} pedidos verificados. Se vuelve a validar pago, factura, envío y bloqueos de cada pedido.`
        : dialog?.kind === "confirm" ? `¿Confirmás que el pedido ${orderCode(dialog.item.order_id)} (${dialog.item.preparedCode}) está físicamente dentro de este Bulto general?`
        : "Esta acción quedará registrada."}
      onClose={() => setDialog(null)}
      footer={<div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <AdminButton className="h-11" onClick={() => setDialog(null)}>Cancelar</AdminButton>
        <AdminPrimaryButton className="h-11" disabled={busy || ((dialog?.kind === "handover" || dialog?.kind === "close") && (liveUpdating || boardError)) || (dialog?.kind === "remove" && reason.trim().length < 10)}
          onClick={() => dialog?.kind === "confirm" ? confirmManually(dialog.item) : confirmDialog()}>{dialog?.kind === "handover" ? "Confirmar entrega" : dialog?.kind === "close" ? "Cerrar Bulto general" : dialog?.kind === "confirm" ? "Confirmar verificado" : "Confirmar"}</AdminPrimaryButton>
      </div>}>
      {dialog?.kind === "remove" && <AdminTextInput title="Motivo obligatorio" value={reason} onChange={setReason} placeholder="Ingresá el motivo (mínimo 10 caracteres)" />}
      {dialog?.kind === "confirm" && <p className="text-sm text-white/70">Usalo sólo si no podés leer ni ingresar el BX-PREP. Queda registrado como confirmación manual, con tu usuario y la hora.</p>}
      {dialog?.kind === "handover" && <p className="text-sm text-white/70">Este paso registra el momento en que la mercadería salió físicamente de BEYONIX. Estado final: ENTREGADO A ANDREANI.</p>}
      {dialog?.kind === "close" && <p className="text-sm text-white/70">Al cerrar, el DSP queda listo para la entrega. Si después se cancela un pedido, el Bulto general queda en revisión hasta retirarlo y volver a validar.</p>}
      {error && <p role="alert" className="mt-2 text-sm font-bold text-red-300">{error}</p>}
    </AdminModal>
    <LabelPrintDialog open={dialog?.kind === "label"} title="Etiqueta del Bulto general" description={`${batch.code} · Pedidos: ${items.length} / Paquetes: ${detail.parcelCount}`} labels={batchLabel} onClose={() => setDialog(null)} />
  </div>
}

function FeedbackLine({ feedback }: { feedback: Feedback }) {
  const Icon = feedback.tone === "error" ? XCircle : feedback.tone === "warning" ? AlertTriangle : CheckCircle2
  return <p role="status" className={`flex items-start gap-2 text-sm font-bold ${feedback.tone === "success" ? "text-emerald-300" : feedback.tone === "warning" ? "text-amber-300" : "text-red-300"}`}><Icon className="mt-0.5 size-5 shrink-0" />{feedback.message}</p>
}
