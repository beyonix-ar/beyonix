"use client"

import { useEffect, useRef, useState, type FormEvent } from "react"
import Link from "next/link"
import { AlertTriangle, CheckCircle2, Circle, Lock, PackagePlus, PackageX, Printer, Truck, XCircle } from "lucide-react"

import { AdminBadge, AdminButton, AdminCard, AdminModal, AdminPrimaryButton, AdminRowMenu, AdminTextInput, type AdminRowMenuAction } from "@/app/admin/components/admin-controls"
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
type Dialog = { kind: "remove"; orderId: number } | { kind: "confirm"; item: DispatchBatchItem } | { kind: "close" } | { kind: "handover"; code: string } | { kind: "label" } | { kind: "add" }

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`
const dateTime = (value: string | null | undefined) =>
  value ? new Intl.DateTimeFormat("es-AR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)) : "—"

/**
 * Bulto general (dispatch_batches): pedidos ESPERADOS vs VERIFICADOS. Cada
 * pedido se verifica con su etiqueta Andreani por lector, cámara, tipeo/pegado
 * o una confirmación manual explícita; todo pasa por la misma acción "verify".
 * Una sola acción principal por estado: cerrar (abierto) o entregar (cerrado).
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
    if (next.tone !== "success") setIssueCount((count) => count + 1)
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
        // Un código incorrecto avisa y no rompe nada: la lectura sigue disponible.
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
    void run(async () => { onChange(await dispatchRequest<BatchDispatchDetail>(`/batches/${batch.id}`, { action: "add", orderId: id })); setAddCode(""); setDialog(null) })
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

  const statusLabel = batch.status === "handed_over" ? "Entregado a Andreani" : blocked ? "Requiere revisión" : detail.requiresRevalidation ? "Volver a validar" : batch.status === "open" ? "Abierto" : "Cerrado · listo para entregar"
  const statusTone = batch.status === "handed_over" ? "success" : blocked ? "danger" : detail.requiresRevalidation ? "warning" : batch.status === "open" ? "info" : "success"
  const batchLabel = [{ kind: "batch" as const, code: batch.code, date: dateTime(batch.closed_at) }]
  const firstBlocked = items.find((item) => item.blocked)
  const dialogOpen = dialog !== null && dialog.kind !== "label"
  const labelItems: AdminRowMenuAction[] = batch.status !== "open" ? [{ key: "label", label: "Imprimir etiqueta del Bulto general", icon: <Printer className="size-4" />, onSelect: () => setDialog({ kind: "label" }) }] : []
  const bundleItems: AdminRowMenuAction[] = batch.status === "open" ? [{ key: "add", label: "Agregar pedido por número", icon: <PackagePlus className="size-4" />, onSelect: () => { setAddCode(""); setDialog({ kind: "add" }) } }] : []

  return <div className="mx-auto w-full max-w-3xl min-w-0 space-y-3">
    {error && <div role="alert" className="rounded-xl border border-red-500/35 bg-red-950 p-3 text-sm text-white">{error}</div>}
    <AdminCard className="dispatch-card min-w-0 p-0">
      <div className="space-y-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <span className="block text-10px font-black uppercase tracking-widest text-sky-200/70">Bulto general</span>
            <h3 className="truncate font-mono text-xl font-black text-white">{batch.code}</h3>
          </div>
          <AdminBadge tone={statusTone}>{statusLabel}</AdminBadge>
        </div>
        {(labelItems.length > 0 || bundleItems.length > 0) && <div className="flex flex-wrap gap-2" aria-label="Acciones secundarias">
          {labelItems.length > 0 && <AdminRowMenu triggerLabel="Etiquetas" ariaLabel="Etiquetas" items={labelItems} />}
          {bundleItems.length > 0 && <AdminRowMenu triggerLabel="Bulto" ariaLabel="Bulto general" items={bundleItems} />}
        </div>}
        <p className="text-sm text-white/70" aria-label="Control del Bulto general">
          Pedidos esperados: <span className="font-black tabular-nums text-white">{detail.expectedCount}</span> · Verificados: <span className="font-black tabular-nums text-emerald-300">{detail.verifiedCount}</span>
          {issueCount > 0 && <> · Lecturas con error: <span className="font-black tabular-nums text-amber-300">{issueCount}</span></>}
        </p>
        {batch.status !== "handed_over" && <DispatchProgress done={detail.verifiedCount} total={detail.expectedCount} unit="pedidos verificados" />}
        {blocked && <p role="alert" className="flex items-start gap-2 text-sm font-bold text-red-200"><AlertTriangle className="mt-0.5 size-4 shrink-0" />{plural(detail.blockedCount, "pedido requiere", "pedidos requieren")} revisión{firstBlocked ? ` (${orderCode(firstBlocked.order_id)})` : ""}. No se puede cerrar ni entregar hasta retirarlo físicamente.</p>}
        {detail.requiresRevalidation && !blocked && <p role="alert" className="flex items-start gap-2 text-sm font-bold text-amber-200"><AlertTriangle className="mt-0.5 size-4 shrink-0" />La composición cambió: volvé a validar {plural(detail.missingCount, "pedido", "pedidos")} antes de entregar.</p>}
        {detail.verificationRequired === false && <p className="text-xs text-white/60">Histórico: sólo figuran como verificados los pedidos con escaneos registrados.</p>}
        {batch.status === "handed_over" && <p role="status" className="text-sm font-bold text-emerald-300">✓ Entregado a Andreani · {dateTime(batch.handed_over_at)}{detail.operatorName ? ` · ${detail.operatorName}` : ""}</p>}
        {canVerify && <div className="space-y-2">
          <p className="text-sm font-bold text-white">Escaneá la etiqueta Andreani de cada pedido.</p>
          <ScanField label="Escanear o ingresar etiqueta Andreani" placeholder="Etiqueta Andreani del pedido" submitLabel="Verificar"
            value={scan} onChange={(value) => { setScan(value); scanKey.current = null }} onScan={submitScan}
            busy={busy} autoFocus={dialog === null} cameraTitle={`Bulto general ${batch.code}`} cameraHint="Encuadrá el código de barras de la etiqueta Andreani" continuousCamera feedback={feedback} />
        </div>}
        {feedback && <FeedbackLine feedback={feedback} />}
      </div>

      {items.length > 0 ? <ul className="dispatch-divider dispatch-lines border-t px-4 sm:px-5" aria-label="Pedidos del Bulto general">{items.map((item) => {
        const hold = item.cancellationHold ? holds.find((entry) => entry.orderId === item.order_id) : undefined
        const Icon = item.blocked ? XCircle : item.verified ? CheckCircle2 : Circle
        const legacy = !item.verified && detail.verificationRequired === false
        const badge = item.cancellationHold ? "Cancelado · retirar" : item.blocked ? "Requiere revisión" : item.verified ? "Verificado" : legacy ? "Sin verificación" : "Pendiente"
        const rowItems: AdminRowMenuAction[] = [
          ...(!item.verified && !item.blocked && canVerify ? [{ key: "confirm", label: "Confirmar a mano", icon: <CheckCircle2 className="size-4" />, disabled: busy, onSelect: () => setDialog({ kind: "confirm", item }) }] : []),
          { key: "remove", label: "Retirar del Bulto general", icon: <PackageX className="size-4" />, tone: "danger", disabled: busy, onSelect: () => { setReason(""); setDialog({ kind: "remove", orderId: item.order_id }) } },
        ]
        return <li key={item.id} data-dispatch-blocked={item.blocked ? "true" : undefined} data-verified={item.verified ? "true" : undefined} className="flex flex-wrap items-center gap-3 py-3">
          <Icon aria-hidden="true" className={`size-5 shrink-0 ${item.blocked ? "text-red-300" : item.verified ? "text-emerald-300" : "text-white/40"}`} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Link href={`/admin/pedidos/${item.order_id}`} className="font-black tabular-nums text-white underline">{orderCode(item.order_id)}</Link>
              <AdminBadge tone={item.blocked ? "danger" : item.verified ? "success" : legacy ? "neutral" : "warning"}>{badge}</AdminBadge>
            </div>
            <p className="mt-0.5 break-all text-xs text-white/60"><span className="font-mono">{item.labelCode}</span>{item.verified && item.verificationMethod ? ` · ${DISPATCH_VERIFICATION_METHOD_LABELS[item.verificationMethod]}` : ""}</p>
            {item.blocked && <p role="alert" className="mt-1 text-xs font-bold text-white">{item.cancellationHold ? `${orderCode(item.order_id)} fue cancelado y está dentro de este Bulto general: retiralo y escanealo.` : `Pedido bloqueado · ${item.blockReason ?? "Revisión requerida"}`}</p>}
          </div>
          {batch.status !== "handed_over" && (item.cancellationHold
            ? <AdminPrimaryButton className="h-11 w-full sm:w-auto" disabled={!hold} onClick={() => hold && onOpenResolution(hold)}>Escanear para retirar</AdminPrimaryButton>
            : <AdminRowMenu ariaLabel={`Opciones de ${orderCode(item.order_id)}`} items={rowItems} />)}
        </li>
      })}</ul> : <p className="dispatch-divider border-t px-4 py-4 text-sm text-white/60 sm:px-5">El Bulto general no tiene pedidos. Agregá pedidos listos desde Preparación.</p>}

      {batch.status === "open" && <div className="dispatch-divider dispatch-primary-bar border-t p-4 sm:p-5">
        <AdminPrimaryButton className="h-12 w-full justify-center text-base" icon={<Lock className="size-5" />} disabled={busy || liveUpdating || !allVerified || blocked} onClick={() => setDialog({ kind: "close" })}>CERRAR BULTO GENERAL</AdminPrimaryButton>
        {!allVerified && items.length > 0 && <p className="mt-2 text-center text-xs text-white/60">Faltan {plural(detail.missingCount, "pedido", "pedidos")} por verificar para cerrar.</p>}
      </div>}
      {batch.status === "closed" && <div className="dispatch-divider dispatch-primary-bar space-y-3 border-t p-4 sm:p-5">
        <p className="flex items-center gap-2 text-sm font-black text-white"><Truck className="size-5 text-beyonix-sky" />Confirmar entrega a Andreani</p>
        <p className="text-xs text-white/65">En la puerta, escaneá o ingresá el DSP del Bulto general justo antes de entregarlo. Cerrado no es lo mismo que entregado.</p>
        <ScanField label="Escanear o ingresar DSP" placeholder={`Escaneá ${batch.code}`} submitLabel="Verificar DSP"
          value={handoverScan} onChange={setHandoverScan} onScan={scanHandover}
          busy={busy} disabled={exitBlocked} cameraTitle={`Entrega de ${batch.code}`} cameraHint="Encuadrá la etiqueta DSP" feedback={feedback} />
        {blocked && firstBlocked && <p role="alert" className="text-sm text-amber-300">{orderCode(firstBlocked.order_id)} requiere revisión antes de la entrega.</p>}
        {detail.requiresRevalidation && !blocked && <p role="alert" className="text-sm text-amber-300">Volvé a validar los pedidos antes de la entrega.</p>}
      </div>}
    </AdminCard>

    {batch.status !== "open" && <details className="text-sm text-white/70">
      <summary className="cursor-pointer">Ver etiqueta del Bulto general</summary>
      <div className="mt-3"><DispatchLabel batch={batch} barcodeUrl={barcodeUrl} /></div>
    </details>}

    <AdminModal open={dialogOpen && !(blocked && (dialog?.kind === "close" || dialog?.kind === "handover"))} compact
      title={dialog?.kind === "remove" ? "Retirar pedido del Bulto general" : dialog?.kind === "confirm" ? "Confirmar pedido manualmente" : dialog?.kind === "close" ? "CERRAR BULTO GENERAL" : dialog?.kind === "add" ? "Agregar pedido" : "Confirmar entrega a Andreani"}
      description={dialog?.kind === "handover" ? `Ingresaste ${dialog.code}. ¿Confirmás que el Bulto general salió físicamente hacia Andreani? Pedidos: ${items.length}.`
        : dialog?.kind === "close" ? `${batch.code} · ${detail.verifiedCount} de ${detail.expectedCount} pedidos verificados. Se vuelve a validar pago, factura, envío y bloqueos de cada pedido.`
        : dialog?.kind === "confirm" ? `¿Confirmás que el pedido ${orderCode(dialog.item.order_id)} (${dialog.item.labelCode}) está físicamente dentro de este Bulto general?`
        : dialog?.kind === "add" ? "Sólo entran pedidos con el envío Andreani generado y su etiqueta impresa."
        : "Esta acción quedará registrada."}
      onClose={() => setDialog(null)}
      footer={dialog?.kind === "add" ? undefined : <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <AdminButton className="h-11" onClick={() => setDialog(null)}>Cancelar</AdminButton>
        <AdminPrimaryButton className="h-11" disabled={busy || ((dialog?.kind === "handover" || dialog?.kind === "close") && (liveUpdating || boardError)) || (dialog?.kind === "remove" && reason.trim().length < 10)}
          onClick={() => dialog?.kind === "confirm" ? confirmManually(dialog.item) : confirmDialog()}>{dialog?.kind === "handover" ? "Confirmar entrega" : dialog?.kind === "close" ? "Cerrar Bulto general" : dialog?.kind === "confirm" ? "Confirmar verificado" : "Confirmar"}</AdminPrimaryButton>
      </div>}>
      {dialog?.kind === "remove" && <AdminTextInput title="Motivo obligatorio" value={reason} onChange={setReason} placeholder="Ingresá el motivo (mínimo 10 caracteres)" />}
      {dialog?.kind === "confirm" && <p className="text-sm text-white/70">Usalo sólo si no podés leer ni ingresar la etiqueta Andreani. Queda registrado como confirmación manual, con tu usuario y la hora.</p>}
      {dialog?.kind === "handover" && <p className="text-sm text-white/70">Este paso registra el momento en que la mercadería salió físicamente de BEYONIX. Estado final: ENTREGADO A ANDREANI.</p>}
      {dialog?.kind === "close" && <p className="text-sm text-white/70">Al cerrar se genera la etiqueta del Bulto general (DSP). Si después se cancela un pedido, el Bulto general queda en revisión hasta retirarlo y volver a validar.</p>}
      {dialog?.kind === "add" && <form onSubmit={addOrder} className="flex flex-col gap-2 sm:flex-row"><div className="flex-1"><AdminTextInput title="Pedido" value={addCode} onChange={setAddCode} placeholder="BX-1031" /></div><AdminPrimaryButton type="submit" disabled={busy || !addCode.trim()}>Agregar</AdminPrimaryButton></form>}
      {error && <p role="alert" className="mt-2 text-sm font-bold text-red-300">{error}</p>}
    </AdminModal>
    <LabelPrintDialog open={dialog?.kind === "label"} title="Etiqueta del Bulto general" description={batch.code} labels={batchLabel} onClose={() => setDialog(null)} />
  </div>
}

function FeedbackLine({ feedback }: { feedback: Feedback }) {
  const Icon = feedback.tone === "error" ? XCircle : feedback.tone === "warning" ? AlertTriangle : CheckCircle2
  return <p role="status" className={`flex items-start gap-2 text-sm font-bold ${feedback.tone === "success" ? "text-emerald-300" : feedback.tone === "warning" ? "text-amber-300" : "text-red-300"}`}><Icon className="mt-0.5 size-5 shrink-0" />{feedback.message}</p>
}
