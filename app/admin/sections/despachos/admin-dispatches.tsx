"use client"

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react"
import Link from "next/link"
import { AlertTriangle, CheckCircle2, Info, Layers, PackageCheck, PackageOpen, PackageX, Printer, RotateCcw, Truck, XCircle } from "lucide-react"

import {
  AdminBadge, AdminButton, AdminCard, AdminEmptyState, AdminModal,
  AdminPageHeader, AdminPrimaryButton, AdminSection, AdminTextInput,
  adminPageClassName,
} from "@/app/admin/components/admin-controls"
import { LabelPrintDialog } from "@/app/admin/components/label-print-dialog"
import { supabase } from "@/lib/supabase/client"
import { ADMIN_DISPATCH_CHANGED_EVENT } from "@/hooks/use-admin-notifications"
import { DISPATCH_STAGE_LABELS, dispatchStage, orderCode, type BatchDispatchDetail, type DispatchBatch, type DispatchHold, type DispatchMembership, type DispatchOrder, type DispatchPackage } from "@/lib/admin/dispatch"
import { normalizeScannedCode, orderIdFromDispatchCode } from "@/lib/admin/dispatch-scan"
import { playScanFeedback } from "@/lib/admin/scan-feedback"
import { CancellationResolution } from "./cancellation-resolution"
import { DispatchLabel } from "./dispatch-label"
import { DispatchProgress } from "./dispatch-progress"
import { DispatchRequestError, dispatchRequest } from "./dispatch-request"
import { DISPATCH_STAGE_TONE, OrderPreparationPanel } from "./order-preparation-panel"
import { ScanField } from "./scan-field"

type Tab = "armado" | "ready" | "open" | "closed" | "handed_over"
type OrderCard = DispatchOrder & {
  package: DispatchPackage | null; membership: DispatchMembership | null; blocked?: boolean; blockReason?: string | null
  packingBlocked?: boolean; pendingBeforeDispatch?: string[]; itemCount?: number; units?: number; scannedUnits?: number
}
type BatchCard = DispatchBatch & { orderCount: number; packageCount: number; blockedCount: number }
type Board = { orders: OrderCard[]; batches: BatchCard[]; holds?: DispatchHold[] }
type ParcelScan = { orderId: number; parcelIndex: number; parcelCount: number; scannedCount: number; complete: boolean; duplicate: boolean }
type BatchResponse = BatchDispatchDetail & { scan?: ParcelScan | null; handover?: { duplicate: boolean } | null }
type Feedback = { tone: "success" | "warning" | "error"; message: string }

const SELECTION_KEY = "beyonix:dispatch-lot-selection"

function readSelection() {
  try {
    const parsed: unknown = JSON.parse(window.sessionStorage.getItem(SELECTION_KEY) ?? "[]")
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is number => Number.isSafeInteger(id) && id > 0) : [])
  } catch { return new Set<number>() }
}

function writeSelection(selection: Set<number>) {
  try { window.sessionStorage.setItem(SELECTION_KEY, JSON.stringify([...selection])) } catch { /* Preferencia local opcional. */ }
}

function dateTime(value: string | null | undefined) {
  return value ? new Intl.DateTimeFormat("es-AR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)) : "—"
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

const TABS: { key: Tab; label: string }[] = [
  { key: "armado", label: "Armado" }, { key: "ready", label: "Bultos listos" },
  { key: "open", label: "Lotes abiertos" }, { key: "closed", label: "Lotes cerrados" },
  { key: "handed_over", label: "Entregados" },
]

export function AdminDispatches({ initialBatchId, initialOrderId, initialResolveId }: { initialBatchId?: string; initialOrderId?: string; initialResolveId?: string }) {
  const [tab, setTab] = useState<Tab>(initialBatchId ? "closed" : "armado")
  const [board, setBoard] = useState<Board | null>(null)
  const [orderId, setOrderId] = useState<number | null>(null)
  const [queue, setQueue] = useState<number[]>([])
  const [batch, setBatch] = useState<BatchDispatchDetail | null>(null)
  const [resolving, setResolving] = useState<DispatchHold | null>(null)
  const [loading, setLoading] = useState(false)
  const [liveUpdating, setLiveUpdating] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [searchOrder, setSearchOrder] = useState("")
  const [parcelScan, setParcelScan] = useState("")
  const [scanFeedback, setScanFeedback] = useState<Feedback | null>(null)
  const [handoverScan, setHandoverScan] = useState("")
  const [handoverCode, setHandoverCode] = useState<string | null>(null)
  const [reason, setReason] = useState("")
  const [dialog, setDialog] = useState<"remove" | "close" | "handover" | "label" | null>(null)
  const [removeOrderId, setRemoveOrderId] = useState<number | null>(null)
  const [barcodeUrl, setBarcodeUrl] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<number>>(() => new Set())
  const [armadoSelected, setArmadoSelected] = useState<Set<number>>(() => new Set())
  const createKey = useRef<string | null>(null)
  const scanKey = useRef<string | null>(null)
  const busyRef = useRef(false)
  const resolveHandled = useRef(false)

  useEffect(() => { setSelected(readSelection()) }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    try { setBoard(await dispatchRequest<Board>("")); setError("") }
    catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudieron cargar los despachos.") }
    finally { setLoading(false) }
  }, [])

  const openBatch = useCallback(async (id: number) => {
    setLoading(true); setError(""); setScanFeedback(null)
    try { const detail = await dispatchRequest<BatchDispatchDetail>(`/batches/${id}`); setBatch(detail); setTab(detail.batch.status); setOrderId(null); setResolving(null) }
    catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo abrir el lote.") }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { void refresh() }, [refresh])
  const activeBatchId = batch?.batch.id
  const activeBatchStatus = batch?.batch.status
  useEffect(() => {
    setLiveUpdating(false)
    let timer: ReturnType<typeof setTimeout> | null = null
    let active = true
    let version = 0
    const reload = () => {
      if (timer) clearTimeout(timer)
      setLiveUpdating(true)
      timer = setTimeout(async () => {
        timer = null
        const current = ++version
        try {
          const [nextBoard, nextBatch] = await Promise.all([
            dispatchRequest<Board>(""),
            activeBatchId ? dispatchRequest<BatchDispatchDetail>(`/batches/${activeBatchId}`) : Promise.resolve(null),
          ])
          if (!active || current !== version) return
          setBoard(nextBoard)
          if (nextBatch) {
            setBatch(nextBatch)
            if (nextBatch.blockedCount > 0) setDialog((value) => value === "handover" || value === "close" ? null : value)
          }
          setLiveUpdating(false)
          setError("")
        } catch { if (active && current === version) setError("No se pudo actualizar Despachos. Reintentá antes de confirmar la entrega.") }
      }, 180)
    }
    const onFocus = () => { if (document.visibilityState === "visible") reload() }
    window.addEventListener(ADMIN_DISPATCH_CHANGED_EVENT, reload)
    window.addEventListener("focus", onFocus)
    document.addEventListener("visibilitychange", onFocus)
    return () => {
      active = false
      if (timer) clearTimeout(timer)
      window.removeEventListener(ADMIN_DISPATCH_CHANGED_EVENT, reload)
      window.removeEventListener("focus", onFocus)
      document.removeEventListener("visibilitychange", onFocus)
    }
  }, [activeBatchId])
  useEffect(() => {
    const id = Number(initialOrderId)
    if (Number.isSafeInteger(id) && id > 0) { setOrderId(id); setTab("armado") }
    else if (initialBatchId) {
      const batchId = Number(initialBatchId)
      if (Number.isSafeInteger(batchId) && batchId > 0) void openBatch(batchId)
    }
  }, [initialBatchId, initialOrderId, openBatch])

  const holds = useMemo(() => board?.holds ?? [], [board])
  // Acceso directo desde la alerta: /admin/despachos?resolve=<pedido>.
  useEffect(() => {
    if (resolveHandled.current || !board) return
    const id = Number(initialResolveId)
    if (!Number.isSafeInteger(id) || id <= 0) return
    resolveHandled.current = true
    const hold = holds.find((item) => item.orderId === id)
    if (hold) { setResolving(hold); setOrderId(null); setBatch(null) }
  }, [board, holds, initialResolveId])

  useEffect(() => {
    if (!activeBatchId || activeBatchStatus === "open") { setBarcodeUrl(null); return }
    let cancelled = false
    let objectUrl: string | null = null
    void (async () => {
      try {
        const { data } = await supabase.auth.getSession()
        if (!data.session) return
        const response = await fetch(`/api/admin/dispatch/batches/${activeBatchId}/barcode`, { headers: { Authorization: `Bearer ${data.session.access_token}` }, cache: "no-store" })
        if (!response.ok) return
        objectUrl = URL.createObjectURL(await response.blob())
        if (!cancelled) setBarcodeUrl(objectUrl)
      } catch { /* El lote sigue disponible aunque la vista previa no cargue. */ }
    })()
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); setBarcodeUrl(null) }
  }, [activeBatchId, activeBatchStatus])

  async function run(action: () => Promise<void>) {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true); setError("")
    try { await action(); await refresh() }
    catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo completar la operación.") }
    finally { busyRef.current = false; setBusy(false) }
  }

  const orders = useMemo(() => board?.orders ?? [], [board])
  const armadoOrders = orders.filter((item) => !item.membership && (!item.package || item.package.status === "preparing" || !item.package.parcel_count))
  const readyOrders = orders.filter((item) => !item.membership && item.package?.status === "prepared" && Boolean(item.package.parcel_count))
  const eligibleReady = readyOrders.filter((item) => !item.blocked)
  const selectedReady = eligibleReady.filter((item) => selected.has(item.id))
  const selectedParcels = selectedReady.reduce((sum, item) => sum + (item.package?.parcel_count ?? 0), 0)
  const shownBatches = (board?.batches ?? []).filter((item) => item.status === tab)
  const reviewCount = (board?.batches ?? []).filter((item) => item.status !== "handed_over" && item.blockedCount > 0).length

  function toggleSelected(id: number) {
    createKey.current = null
    setSelected((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); writeSelection(next); return next })
  }
  function setAllSelected(ids: number[]) {
    createKey.current = null
    const next = new Set(ids); writeSelection(next); setSelected(next)
  }

  function startArmado(ids: number[]) {
    if (!ids.length) return
    setQueue(ids); setOrderId(ids[0]); setBatch(null); setResolving(null); setError("")
  }

  function openResolution(hold: DispatchHold) {
    setResolving(hold); setOrderId(null); setQueue([]); setBatch(null); setError("")
  }

  function submitOrderSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    // Pedido (BX-1031), pedido preparado (BX-PREP-1031) o bulto (BX-PKG-1031-01).
    const id = orderIdFromDispatchCode(searchOrder)
    if (!id) { setError("Ingresá o escaneá un pedido como BX-1031."); return }
    const hold = holds.find((item) => item.orderId === id)
    if (hold && !batch) { openResolution(hold); setSearchOrder(""); return }
    if (!batch) { startArmado([id]); setSearchOrder(""); return }
    void run(async () => { setBatch(await dispatchRequest<BatchDispatchDetail>(`/batches/${batch.batch.id}`, { action: "add", orderId: id })); setSearchOrder("") })
  }

  function createLot() {
    const orderIds = selectedReady.map((item) => item.id)
    if (!orderIds.length) return
    createKey.current ??= crypto.randomUUID()
    void run(async () => {
      const detail = await dispatchRequest<BatchDispatchDetail>("/batches", { requestKey: createKey.current, orderIds })
      createKey.current = null
      setAllSelected([])
      setBatch(detail); setTab("open")
    })
  }

  function submitParcelScan(code: string) {
    if (!batch || busyRef.current) return
    if (code !== parcelScan.trim()) scanKey.current = null
    setParcelScan(code)
    scanKey.current ??= crypto.randomUUID()
    const requestKey = scanKey.current
    busyRef.current = true
    setBusy(true)
    void (async () => {
      try {
        const updated = await dispatchRequest<BatchResponse>(`/batches/${batch.batch.id}`, { action: "scan", code, requestKey })
        setBatch(updated)
        const result = updated.scan
        setScanFeedback(result ? { tone: result.duplicate ? "warning" : "success", message: `${result.duplicate ? "Bulto ya escaneado" : "✓"} ${orderCode(result.orderId)} · Bulto ${result.parcelIndex}/${result.parcelCount} · ${result.complete ? "pedido completo" : `${result.scannedCount} de ${result.parcelCount} bultos`}` } : { tone: "success", message: "✓ Bulto verificado" })
        playScanFeedback(result?.duplicate ? "warning" : "success")
        setParcelScan(""); scanKey.current = null
        void refresh()
      } catch (cause) {
        if (!(cause instanceof DispatchRequestError && cause.retryable)) { scanKey.current = null; setParcelScan("") }
        setScanFeedback({ tone: "error", message: cause instanceof Error ? cause.message : "No se pudo verificar el bulto." })
        playScanFeedback("error")
      } finally {
        busyRef.current = false
        setBusy(false)
      }
    })()
  }

  // Salida física: la etiqueta del lote se escanea en la puerta; la base
  // vuelve a validar el código antes de registrar la entrega.
  function scanHandover(code: string) {
    if (!batch) return
    const normalized = normalizeScannedCode(code)?.toUpperCase() ?? ""
    setHandoverScan("")
    if (normalized !== batch.batch.code) {
      setScanFeedback({ tone: "error", message: "Ese código no corresponde a este lote. Escaneá la etiqueta del lote que estás entregando." })
      playScanFeedback("error")
      return
    }
    setScanFeedback(null)
    playScanFeedback("success")
    setHandoverCode(normalized)
    setDialog("handover")
  }

  const batchParcels = batch?.parcelCount ?? 0
  const batchComplete = Boolean(batch && batch.items.length > 0 && batch.items.every((item) => item.parcelCount && item.scannedParcels === item.parcelCount))
  const verifiedOrders = batch ? batch.items.filter((item) => item.parcelCount && item.scannedParcels === item.parcelCount).length : 0
  const batchLabel = batch ? [{ kind: "batch" as const, code: batch.batch.code, orderCount: batch.items.length, parcelCount: batchParcels, date: dateTime(batch.batch.closed_at) }] : []
  const queueIndex = orderId ? queue.indexOf(orderId) : -1
  const nextInQueue = queueIndex >= 0 ? queue[queueIndex + 1] : undefined
  const closeOrder = () => { setOrderId(null); setQueue([]); void refresh() }
  const batchBlockedForExit = Boolean(batch && batch.blockedCount > 0)

  // Contadores sólo de las colas operativas: el board trae hasta 100 lotes,
  // así que cerrados/entregados no tendrían un total confiable.
  const openBatchCount = (board?.batches ?? []).filter((item) => item.status === "open").length
  const tabCounts: Partial<Record<Tab, number>> = board ? { armado: armadoOrders.length, ready: readyOrders.length, open: openBatchCount } : {}
  const actionCount = reviewCount + holds.filter((hold) => !hold.batchId).length
  const metrics: { label: string; value: number; icon: ReactNode; tone: "neutral" | "info" | "success" | "warning"; status?: string }[] = [
    { label: "En armado", value: armadoOrders.length, icon: <PackageOpen className="size-4" />, tone: "info" },
    { label: "Bultos listos", value: readyOrders.length, icon: <PackageCheck className="size-4" />, tone: "success" },
    { label: "Lotes abiertos", value: openBatchCount, icon: <Layers className="size-4" />, tone: "info" },
    { label: "Requieren acción", value: actionCount, icon: <AlertTriangle className="size-4" />, tone: actionCount > 0 ? "warning" : "neutral", status: `Despachos · ${actionCount} requieren acción` },
  ]

  return <div className={`${adminPageClassName} mx-auto max-w-7xl`}>
    <AdminPageHeader className="sm:flex-row sm:items-end sm:justify-between" eyebrow="Operación" title="Despachos" description="Prepará pedidos, creá lotes de envío y confirmá la entrega física a Andreani." actions={<AdminButton onClick={() => void refresh()} disabled={loading || busy} icon={<RotateCcw className={`size-4 ${loading ? "animate-spin" : ""}`} />}>Actualizar</AdminButton>} />

    {holds.length > 0 && !resolving && <section aria-label="Cancelaciones que requieren acción" className="space-y-2">
      {holds.map((hold) => <div key={hold.id} role="alert" className="flex flex-col gap-3 rounded-2xl border border-red-500/45 bg-red-950 p-3 sm:flex-row sm:items-center sm:justify-between sm:p-4">
        <div className="min-w-0">
          <p className="flex items-center gap-2 font-black text-white"><PackageX className="size-5 shrink-0 text-red-300" />Pedido {orderCode(hold.orderId)} cancelado</p>
          <p className="mt-0.5 text-sm text-white/80">{hold.prepared ? "Ya fue preparado físicamente" : `Ya tenía ${hold.pickedUnits} de ${hold.units} unidades pickeadas`}{hold.batchCode ? ` y está en ${hold.batchCode}` : ""}. Stock retenido · requiere resolución física · reintegro manual.</p>
        </div>
        <AdminPrimaryButton className="h-12 w-full shrink-0 sm:w-auto" onClick={() => openResolution(hold)}>ESCANEAR PEDIDO PARA LIBERAR STOCK</AdminPrimaryButton>
      </div>)}
    </section>}

    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {metrics.map((metric) => <AdminCard key={metric.label} role={metric.status ? "status" : undefined} aria-label={metric.status} className="dispatch-card flex items-center gap-3 p-3">
          <span className={`admin-ds-badge admin-ds-tone-${metric.tone} flex size-9 shrink-0 items-center justify-center p-0`} aria-hidden="true">{metric.icon}</span>
          <span className="min-w-0">
            <span className="block truncate text-10px font-black uppercase tracking-widest text-white/60">{metric.label}</span>
            <span className="block text-xl font-black leading-tight tabular-nums text-white">{board ? metric.value : "—"}</span>
          </span>
        </AdminCard>)}
      </div>
      <nav aria-label="Estados de despacho" className="admin-ds-card admin-ds-surface bx-surface bx-surface-section dispatch-surface flex gap-1 overflow-x-auto p-1">
        {TABS.map((item) => {
          const active = tab === item.key && !resolving
          const count = tabCounts[item.key]
          return <button key={item.key} type="button" aria-current={active ? "page" : undefined} onClick={() => { setTab(item.key); setOrderId(null); setQueue([]); setBatch(null); setResolving(null); setScanFeedback(null); setError("") }} className={`inline-flex h-10 shrink-0 cursor-pointer items-center gap-2 rounded-lg border px-3 text-11px font-black uppercase tracking-wide transition-colors ${active ? "border-beyonix-blue-light bg-beyonix-blue text-white shadow-[0_0_14px_rgba(17,42,67,0.32)]" : "border-transparent text-white/60 hover:bg-white/5 hover:text-white"}`}>
            {item.label}
            {count !== undefined && <span className={`min-w-5 rounded-md px-1.5 py-0.5 text-center text-10px tabular-nums ${active ? "bg-white/15 text-white" : "bg-white/8 text-white/70"}`}>{count}</span>}
          </button>
        })}
      </nav>
    </div>
    {error && <div role="alert" className="rounded-xl border border-red-500/35 bg-red-950 p-3 text-sm text-white">{error}</div>}
    {loading && <p role="status" className="text-sm text-white/70">Cargando…</p>}

    {resolving ? <AdminSection compact className="dispatch-surface max-w-3xl" title={`Retirar ${orderCode(resolving.orderId)}`} eyebrow="Cancelación con armado" actions={<AdminButton size="sm" onClick={() => { setResolving(null); void refresh() }}>Volver</AdminButton>}>
      <CancellationResolution key={resolving.id} hold={resolving} onResolved={() => void refresh()} onClose={() => { setResolving(null); void refresh() }} />
    </AdminSection> : orderId ? <AdminSection compact className="dispatch-surface" title={orderCode(orderId)} eyebrow={queue.length > 1 ? `Armado · ${queueIndex + 1} de ${queue.length}` : "Armado"} actions={<AdminButton size="sm" onClick={closeOrder}>Volver</AdminButton>}>
      <OrderPreparationPanel key={orderId} orderId={orderId} onDone={nextInQueue ? undefined : closeOrder} footer={nextInQueue ? <AdminPrimaryButton className="h-12 w-full sm:w-auto" onClick={() => setOrderId(nextInQueue)}>Siguiente pedido · {orderCode(nextInQueue)}</AdminPrimaryButton> : null} />
    </AdminSection> : batch ? <AdminSection compact className="dispatch-surface" title={batch.batch.code} eyebrow="Lote de envío" actions={<AdminButton size="sm" onClick={() => { setBatch(null); void refresh() }}>Volver</AdminButton>}>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,380px)] lg:items-start">
        <div className="min-w-0 space-y-3">
          <AdminCard className="dispatch-card p-3 sm:p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <AdminBadge tone={batch.batch.status === "handed_over" ? "success" : batch.blockedCount ? "warning" : batch.batch.status === "closed" ? "success" : "info"}>{batch.blockedCount && batch.batch.status !== "handed_over" ? "Requiere revisión" : batch.batch.status === "open" ? "Abierto · cargando" : batch.batch.status === "closed" ? "Lote cerrado" : "Entregado a Andreani"}</AdminBadge>
              <span className="text-sm font-bold text-white">Pedidos: {batch.items.length} / Bultos: {batchParcels}</span>
            </div>
            {batch.batch.status === "open" && <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <DispatchProgress done={verifiedOrders} total={batch.items.length} unit="pedidos completos" />
              <DispatchProgress done={batch.scannedParcelCount ?? 0} total={batchParcels} unit="bultos escaneados" />
            </div>}
            {batch.blockedCount > 0 && batch.batch.status !== "handed_over" && <p role="alert" className="mt-3 flex items-start gap-2 text-sm font-bold text-amber-200"><AlertTriangle className="mt-0.5 size-4 shrink-0" />{plural(batch.blockedCount, "pedido requiere", "pedidos requieren")} revisión. El lote no puede cerrarse ni despacharse hasta resolverlo.</p>}
            {batch.batch.status === "handed_over" && <p role="status" className="mt-3 text-sm font-bold text-emerald-300">✓ Lote entregado a Andreani · {dateTime(batch.batch.handed_over_at)}{batch.operatorName ? ` · ${batch.operatorName}` : ""}</p>}
          </AdminCard>

          {batch.items.length > 0 ? <ul className="space-y-2" aria-label="Pedidos del lote">{batch.items.map((item) => {
            const parcels = item.parcels ?? []
            const complete = Boolean(item.parcelCount) && item.scannedParcels === item.parcelCount
            const hold = item.cancellationHold ? holds.find((entry) => entry.orderId === item.order_id) : undefined
            const missing = Math.max(0, (item.parcelCount ?? 0) - item.scannedParcels)
            return <li key={item.id}><AdminCard data-dispatch-blocked={item.blocked ? "true" : undefined} className={`dispatch-card flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between ${item.blocked ? "border-red-500/50 bg-red-950" : complete ? "border-emerald-500/35" : ""}`}>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={`/admin/pedidos/${item.order_id}`} className="font-black text-white underline">{orderCode(item.order_id)}</Link>
                  <AdminBadge tone={item.blocked ? "danger" : complete || batch.batch.status !== "open" ? "success" : "warning"}>{item.cancellationHold ? "Cancelado" : item.blocked ? "RETIRAR DEL DESPACHO" : complete || batch.batch.status !== "open" ? "Completo" : `Faltan ${missing}`}</AdminBadge>
                </div>
                <p className="mt-1 text-xs text-white/70">{item.parcelCount ? `${batch.batch.status === "open" ? `${item.scannedParcels}/` : ""}${plural(item.parcelCount, "bulto", "bultos")}` : "Bultos sin definir"}</p>
                {item.blocked && <p role="alert" className="mt-1 text-xs font-bold text-white">{item.cancellationHold ? `Pedido ${orderCode(item.order_id)} fue cancelado y está dentro de este lote.` : `Pedido bloqueado · ${item.blockReason ?? "Revisión requerida"}`}</p>}
                {item.blocked && parcels.length > 0 && <p className="mt-1 text-xs text-white/80">Separá: {parcels.map((parcel) => parcel.barcode).join(", ")}</p>}
              </div>
              {batch.batch.status !== "handed_over" && (item.cancellationHold
                ? <AdminPrimaryButton className="h-11 w-full shrink-0 sm:w-auto" disabled={!hold} onClick={() => hold && openResolution(hold)}>Escanear para retirar</AdminPrimaryButton>
                : <AdminButton size="sm" variant="ghost" className="self-start sm:self-auto" onClick={() => { setRemoveOrderId(item.order_id); setReason(""); setDialog("remove") }}>Retirar</AdminButton>)}
            </AdminCard></li>
          })}</ul> : <AdminEmptyState title="El lote no tiene pedidos" description="Escaneá la etiqueta de un bulto para agregar su pedido." />}
        </div>

        <div className={`space-y-3 lg:sticky lg:top-4 ${batch.batch.status === "open" ? "dispatch-action-bar" : ""}`}>
          {batch.batch.status === "open" && <AdminCard className="dispatch-card space-y-3 p-3 sm:p-4">
            <p className="text-sm font-bold text-white">Cargá el lote escaneando la etiqueta de cada bulto.</p>
            <ScanField label="Escanear bulto" placeholder="Escaneá la etiqueta del bulto (BX-PKG-…)" submitLabel="Verificar bulto"
              value={parcelScan} onChange={(value) => { setParcelScan(value); scanKey.current = null }} onScan={submitParcelScan}
              busy={busy} autoFocus={dialog === null} cameraTitle={`Lote ${batch.batch.code}`} cameraHint="Encuadrá la etiqueta del bulto" continuousCamera feedback={scanFeedback} />
            {scanFeedback && <p role="status" className={`flex items-center gap-2 text-sm font-bold ${scanFeedback.tone === "success" ? "text-emerald-300" : scanFeedback.tone === "warning" ? "text-amber-300" : "text-red-300"}`}>{scanFeedback.tone === "error" ? <XCircle className="size-5 shrink-0" /> : scanFeedback.tone === "warning" ? <AlertTriangle className="size-5 shrink-0" /> : <CheckCircle2 className="size-5 shrink-0" />}{scanFeedback.message}</p>}
            <AdminPrimaryButton className="h-12 w-full text-base" disabled={busy || liveUpdating || !batchComplete || batch.blockedCount > 0} onClick={() => setDialog("close")}>CERRAR LOTE</AdminPrimaryButton>
            {!batchComplete && batch.items.length > 0 && <p className="text-xs text-amber-300">Escaneá todos los bultos para cerrar el lote.</p>}
            <details className="text-sm text-white/70"><summary className="cursor-pointer">Agregar pedido completo por número</summary><form onSubmit={submitOrderSearch} className="mt-2 flex flex-col gap-2"><AdminTextInput title="Agregar pedido" value={searchOrder} onChange={setSearchOrder} placeholder="BX-1031" /><AdminButton type="submit" disabled={busy || !searchOrder.trim()}>Agregar pedido</AdminButton></form></details>
          </AdminCard>}
          {batch.batch.status !== "open" && <AdminCard className="dispatch-card space-y-3 p-3 sm:p-4">
            <DispatchLabel batch={batch.batch} orderCount={batch.items.length} parcelCount={batchParcels} barcodeUrl={barcodeUrl} />
            <AdminButton className="w-full" icon={<Printer className="size-4" />} onClick={() => setDialog("label")}>Imprimir etiqueta del lote</AdminButton>
          </AdminCard>}
          {batch.batch.status === "closed" && <AdminCard className="dispatch-card space-y-3 p-3 sm:p-4">
            <p className="flex items-center gap-2 text-sm font-black text-white"><Truck className="size-5 text-beyonix-sky" />Salida a Andreani</p>
            <p className="text-xs text-white/70">Llevá el lote a la puerta y escaneá su etiqueta justo antes de entregarlo. Lote cerrado no es lo mismo que entregado.</p>
            <ScanField label="Escanear etiqueta del lote" placeholder={`Escaneá ${batch.batch.code}`} submitLabel="Verificar lote"
              value={handoverScan} onChange={setHandoverScan} onScan={scanHandover}
              busy={busy} disabled={liveUpdating || Boolean(error) || batchBlockedForExit} cameraTitle={`Entrega de ${batch.batch.code}`} cameraHint="Encuadrá la etiqueta del lote" feedback={scanFeedback} />
            {scanFeedback?.tone === "error" && <p role="alert" className="flex items-center gap-2 text-sm font-bold text-red-300"><XCircle className="size-5 shrink-0" />{scanFeedback.message}</p>}
            {batchBlockedForExit && <p role="alert" className="text-sm text-amber-300">{orderCode(batch.items.find((item) => item.blocked)?.order_id ?? 0)} requiere revisión antes del despacho.</p>}
          </AdminCard>}
        </div>
      </div>
    </AdminSection> : <AdminSection compact className="dispatch-surface" title={TABS.find((item) => item.key === tab)?.label ?? "Despachos"} icon={<PackageCheck className="size-4" />} actions={tab === "ready" ? <AdminPrimaryButton className="w-full sm:w-auto" disabled={busy || selectedReady.length === 0} onClick={createLot}>CREAR LOTE DE ENVÍO{selectedReady.length ? ` · ${selectedReady.length}` : ""}</AdminPrimaryButton> : tab === "armado" && armadoSelected.size > 0 ? <AdminPrimaryButton className="w-full sm:w-auto" onClick={() => startArmado(armadoOrders.filter((item) => armadoSelected.has(item.id)).map((item) => item.id))}>Armar seleccionados · {armadoSelected.size}</AdminPrimaryButton> : undefined}>
      {(tab === "armado" || tab === "ready") && <form onSubmit={submitOrderSearch} className="mb-4 flex flex-col gap-2 sm:flex-row"><div className="flex-1"><AdminTextInput title="Buscar pedido" value={searchOrder} onChange={setSearchOrder} placeholder="Buscar o escanear BX-1031" /></div><AdminButton type="submit" disabled={!searchOrder.trim()}>Abrir pedido</AdminButton></form>}
      {tab === "ready" && readyOrders.length > 0 && <div className="mb-3 flex flex-wrap items-center gap-3 text-sm text-white/80"><label className="flex cursor-pointer items-center gap-2 font-bold"><input type="checkbox" className="size-5" checked={eligibleReady.length > 0 && selectedReady.length === eligibleReady.length} onChange={(event) => setAllSelected(event.target.checked ? eligibleReady.map((item) => item.id) : [])} />Seleccionar todos</label><span>Pedidos: {selectedReady.length} / Bultos: {selectedParcels}</span></div>}
      {(tab === "armado" || tab === "ready") ? (() => {
        const list = tab === "armado" ? armadoOrders : readyOrders
        return list.length ? <ul className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">{list.map((item) => <li key={item.id}><OrderQueueCard item={item} tab={tab}
          checked={tab === "ready" ? selected.has(item.id) : armadoSelected.has(item.id)}
          onToggle={() => tab === "ready" ? toggleSelected(item.id) : setArmadoSelected((current) => { const next = new Set(current); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return next })}
          onOpen={() => startArmado([item.id])} /></li>)}</ul>
          : <AdminEmptyState title="No hay pedidos en esta vista" description={tab === "armado" ? "Los pedidos pagos pendientes de preparar aparecerán acá, sin importar la fecha." : "Los pedidos preparados con bultos definidos aparecerán acá."} />
      })() : <>{shownBatches.length ? <ul className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">{shownBatches.map((item) => <li key={item.id}><AdminCard interactive className={`dispatch-card flex items-center justify-between gap-3 p-3 ${item.blockedCount > 0 && item.status !== "handed_over" ? "border-amber-500/40" : ""}`}><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><p className="font-black text-white">{item.code}</p>{item.blockedCount > 0 && item.status !== "handed_over" ? <AdminBadge tone="warning">Requiere revisión</AdminBadge> : <AdminBadge tone={item.status === "handed_over" ? "success" : "info"}>{item.status === "open" ? "Abierto" : item.status === "closed" ? "Cerrado" : "Entregado"}</AdminBadge>}</div><p className="mt-1 text-xs text-white/60">Pedidos: {item.orderCount} / Bultos: {item.packageCount} · {item.blockedCount} bloqueados</p></div><AdminButton size="sm" onClick={() => void openBatch(item.id)}>Abrir</AdminButton></AdminCard></li>)}</ul> : <AdminEmptyState title="No hay lotes en esta vista" description="Creá un lote desde Bultos listos." />}</>}
    </AdminSection>}

    <AdminModal open={dialog === "remove" || dialog === "close" || dialog === "handover"} title={dialog === "remove" ? "Retirar pedido del lote" : dialog === "close" ? "CERRAR LOTE" : "Confirmar salida a Andreani"} description={dialog === "handover" ? `Escaneaste ${handoverCode ?? ""}. ¿Confirmás que el lote salió físicamente hacia Andreani? Pedidos: ${batch?.items.length ?? 0} / Bultos: ${batchParcels}.` : dialog === "close" ? `${batch?.batch.code} · Pedidos: ${batch?.items.length ?? 0} / Bultos: ${batchParcels}. Se vuelve a validar pago, factura, envío y bloqueos de cada pedido.` : "Esta acción quedará registrada."} onClose={() => setDialog(null)} footer={<div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><AdminButton className="h-11" onClick={() => setDialog(null)}>Cancelar</AdminButton><AdminPrimaryButton className="h-11" disabled={busy || ((dialog === "handover" || dialog === "close") && (liveUpdating || Boolean(error) || Boolean(batch?.blockedCount))) || (dialog === "remove" && reason.trim().length < 10)} onClick={() => void run(async () => {
      if (dialog === "remove" && batch && removeOrderId) setBatch(await dispatchRequest<BatchDispatchDetail>(`/batches/${batch.batch.id}`, { action: "remove", orderId: removeOrderId, reason }))
      else if (dialog === "close" && batch) { setBatch(await dispatchRequest<BatchDispatchDetail>(`/batches/${batch.batch.id}`, { action: "close" })); setTab("closed") }
      else if (dialog === "handover" && batch && handoverCode) {
        const updated = await dispatchRequest<BatchResponse>(`/batches/${batch.batch.id}`, { action: "handover", code: handoverCode })
        setBatch(updated); setTab("handed_over"); setHandoverCode(null)
        setScanFeedback(updated.handover?.duplicate ? { tone: "warning", message: "Este lote ya estaba registrado como entregado." } : { tone: "success", message: "✓ Lote entregado a Andreani" })
      }
      setDialog(null); setReason("")
    })}>{dialog === "handover" ? "Confirmar salida" : dialog === "close" ? "Cerrar lote" : "Confirmar"}</AdminPrimaryButton></div>}>
      {dialog === "remove" && <AdminTextInput title="Motivo obligatorio" value={reason} onChange={setReason} placeholder="Ingresá el motivo (mínimo 10 caracteres)" />}
      {dialog === "handover" && <p className="text-sm text-white/70">Este paso registra el momento en que la mercadería salió físicamente de BEYONIX. Estado final: ENTREGADO A ANDREANI.</p>}
      {dialog === "close" && <p className="text-sm text-white/70">Al cerrar el lote se genera su código para la salida. Si después se cancela un pedido, el lote queda en revisión hasta retirarlo escaneándolo.</p>}
    </AdminModal>
    <LabelPrintDialog open={dialog === "label"} title="Etiqueta del lote" description={batch ? `${batch.batch.code} · Pedidos: ${batch.items.length} / Bultos: ${batchParcels}` : undefined} labels={batchLabel} onClose={() => setDialog(null)} />
  </div>
}

/** Pedido en la cola de armado o listo para lote: identificación, estado, avance y acción. */
function OrderQueueCard({ item, tab, checked, onToggle, onOpen }: {
  item: OrderCard
  tab: "armado" | "ready"
  checked: boolean
  onToggle: () => void
  onOpen: () => void
}) {
  const stage = dispatchStage({ package: item.package, batchStatus: null })
  // En la cola de armado sólo bloquea lo que frena el pickeo; para el lote, cualquier bloqueo.
  const blocked = tab === "ready" ? Boolean(item.blocked) : Boolean(item.packingBlocked ?? item.blocked)
  const disabled = tab === "ready" && blocked
  const pending = item.pendingBeforeDispatch ?? []
  const units = item.units ?? 0
  const started = Boolean(item.package)
  return <AdminCard interactive className={`dispatch-card flex h-full flex-col gap-3 p-3 ${blocked ? "border-red-500/40" : checked ? "border-beyonix-sky/45" : ""}`}>
    <label className={`flex min-w-0 items-start gap-3 ${disabled ? "cursor-not-allowed" : "cursor-pointer"}`}>
      <input type="checkbox" className="mt-0.5 size-5 shrink-0" aria-label={`Seleccionar ${orderCode(item.id)}`} checked={checked && !disabled} disabled={disabled} onChange={onToggle} />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-black tabular-nums text-white">{orderCode(item.id)}</span>
          <AdminBadge tone={blocked ? "danger" : DISPATCH_STAGE_TONE[stage]}>{blocked ? "Requiere revisión" : DISPATCH_STAGE_LABELS[stage]}</AdminBadge>
        </span>
        <span className="mt-0.5 block truncate text-xs text-white/60">{dateTime(item.created_at)}{item.cliente_nombre ? ` · ${item.cliente_nombre}` : ""}</span>
        <span className="mt-1 block text-xs font-bold text-white/75">{plural(item.itemCount ?? 0, "producto", "productos")} · {plural(units, "unidad", "unidades")}{item.package?.parcel_count ? ` · ${plural(item.package.parcel_count, "bulto", "bultos")}` : ""}</span>
      </span>
    </label>
    {tab === "armado" && started && units > 0 && <DispatchProgress compact done={item.scannedUnits ?? 0} total={units} unit="unidades" />}
    {blocked && <p className="flex items-start gap-1.5 text-xs font-bold text-red-200"><XCircle className="mt-0.5 size-3.5 shrink-0" />{item.blockReason ?? "Revisión requerida"}</p>}
    {!blocked && pending.length > 0 && <p className="flex items-start gap-1.5 text-xs text-sky-200"><Info className="mt-0.5 size-3.5 shrink-0" />{pending.join(" · ")}{tab === "armado" ? " — no frena la preparación" : ""}</p>}
    <AdminButton className="mt-auto h-11 w-full" variant={tab === "armado" && !blocked ? "primary" : "secondary"} onClick={onOpen}>{tab === "armado" ? started ? "Continuar armado" : "Iniciar armado" : "Ver pedido"}</AdminButton>
  </AdminCard>
}
