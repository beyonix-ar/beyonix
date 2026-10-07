"use client"

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react"
import Link from "next/link"
import { CheckCircle2, PackageCheck, Printer, RotateCcw, ScanLine, Truck, XCircle } from "lucide-react"

import {
  AdminBadge, AdminButton, AdminCard, AdminEmptyState, AdminModal,
  AdminPageHeader, AdminPrimaryButton, AdminSection, AdminTextInput,
  adminPageClassName,
} from "@/app/admin/components/admin-controls"
import { LabelPrintDialog } from "@/app/admin/components/label-print-dialog"
import { supabase } from "@/lib/supabase/client"
import { ADMIN_DISPATCH_CHANGED_EVENT } from "@/hooks/use-admin-notifications"
import { DISPATCH_STAGE_LABELS, dispatchStage, orderCode, parseOrderCode, type BatchDispatchDetail, type DispatchBatch, type DispatchMembership, type DispatchOrder, type DispatchPackage } from "@/lib/admin/dispatch"
import { DispatchLabel } from "./dispatch-label"
import { DispatchRequestError, dispatchRequest } from "./dispatch-request"
import { OrderPreparationPanel } from "./order-preparation-panel"

type Tab = "armado" | "ready" | "open" | "closed" | "handed_over"
type OrderCard = DispatchOrder & { package: DispatchPackage | null; membership: DispatchMembership | null; blocked?: boolean; blockReason?: string | null }
type BatchCard = DispatchBatch & { orderCount: number; packageCount: number; blockedCount: number }
type Board = { orders: OrderCard[]; batches: BatchCard[] }
type ParcelScan = { orderId: number; parcelIndex: number; parcelCount: number; scannedCount: number; complete: boolean; duplicate: boolean }
type BatchResponse = BatchDispatchDetail & { scan?: ParcelScan | null }

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

function dateTime(value: string | null) {
  return value ? new Intl.DateTimeFormat("es-AR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)) : "—"
}

const TABS: { key: Tab; label: string }[] = [
  { key: "armado", label: "Armado" }, { key: "ready", label: "Bultos listos" },
  { key: "open", label: "Lotes abiertos" }, { key: "closed", label: "Lotes cerrados" },
  { key: "handed_over", label: "Entregados" },
]

export function AdminDispatches({ initialBatchId, initialOrderId }: { initialBatchId?: string; initialOrderId?: string }) {
  const [tab, setTab] = useState<Tab>(initialBatchId ? "closed" : "armado")
  const [board, setBoard] = useState<Board | null>(null)
  const [orderId, setOrderId] = useState<number | null>(null)
  const [queue, setQueue] = useState<number[]>([])
  const [batch, setBatch] = useState<BatchDispatchDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [liveUpdating, setLiveUpdating] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [searchOrder, setSearchOrder] = useState("")
  const [parcelScan, setParcelScan] = useState("")
  const [scanFeedback, setScanFeedback] = useState<{ tone: "success" | "error"; message: string } | null>(null)
  const [reason, setReason] = useState("")
  const [dialog, setDialog] = useState<"remove" | "close" | "handover" | "label" | null>(null)
  const [removeOrderId, setRemoveOrderId] = useState<number | null>(null)
  const [barcodeUrl, setBarcodeUrl] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<number>>(() => new Set())
  const [armadoSelected, setArmadoSelected] = useState<Set<number>>(() => new Set())
  const createKey = useRef<string | null>(null)
  const scanKey = useRef<string | null>(null)
  const busyRef = useRef(false)
  const scanRef = useRef<HTMLInputElement>(null)

  useEffect(() => { setSelected(readSelection()) }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    try { setBoard(await dispatchRequest<Board>("")); setError("") }
    catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudieron cargar los despachos.") }
    finally { setLoading(false) }
  }, [])

  const openBatch = useCallback(async (id: number) => {
    setLoading(true); setError(""); setScanFeedback(null)
    try { const detail = await dispatchRequest<BatchDispatchDetail>(`/batches/${id}`); setBatch(detail); setTab(detail.batch.status); setOrderId(null) }
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
    setQueue(ids); setOrderId(ids[0]); setBatch(null); setError("")
  }

  function submitOrderSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const id = parseOrderCode(searchOrder)
    if (!id) { setError("Ingresá un pedido como BX-1031."); return }
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

  function submitParcelScan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const code = parcelScan.trim()
    if (!batch || !code || busyRef.current) return
    scanKey.current ??= crypto.randomUUID()
    const requestKey = scanKey.current
    busyRef.current = true
    setBusy(true)
    void (async () => {
      try {
        const updated = await dispatchRequest<BatchResponse>(`/batches/${batch.batch.id}`, { action: "scan", code, requestKey })
        setBatch(updated)
        const result = updated.scan
        setScanFeedback(result ? { tone: "success", message: `${result.duplicate ? "Bulto ya escaneado" : "✓"} ${orderCode(result.orderId)} · Bulto ${result.parcelIndex}/${result.parcelCount} · ${result.complete ? "pedido completo" : `${result.scannedCount} de ${result.parcelCount} bultos`}` } : { tone: "success", message: "✓ Bulto verificado" })
        setParcelScan(""); scanKey.current = null
        void refresh()
      } catch (cause) {
        if (!(cause instanceof DispatchRequestError && cause.retryable)) { scanKey.current = null; setParcelScan("") }
        setScanFeedback({ tone: "error", message: cause instanceof Error ? cause.message : "No se pudo verificar el bulto." })
      } finally {
        busyRef.current = false
        setBusy(false)
        scanRef.current?.focus()
      }
    })()
  }

  const batchParcels = batch?.parcelCount ?? 0
  const batchComplete = Boolean(batch && batch.items.length > 0 && batch.items.every((item) => item.parcelCount && item.scannedParcels === item.parcelCount))
  const batchLabel = batch ? [{ kind: "batch" as const, code: batch.batch.code, orderCount: batch.items.length, parcelCount: batchParcels, date: dateTime(batch.batch.closed_at) }] : []
  const queueIndex = orderId ? queue.indexOf(orderId) : -1
  const nextInQueue = queueIndex >= 0 ? queue[queueIndex + 1] : undefined
  const closeOrder = () => { setOrderId(null); setQueue([]); void refresh() }

  return <div className={`${adminPageClassName} mx-auto max-w-7xl`}>
    <AdminPageHeader eyebrow="Operación" title="Despachos" description="Armá pedidos, definí bultos, creá lotes de envío y confirmá la entrega física." actions={<AdminButton onClick={() => void refresh()} disabled={loading || busy} icon={<RotateCcw className="size-4" />}>Actualizar</AdminButton>} />
    <nav aria-label="Estados de despacho" className="flex flex-wrap gap-2">
      {TABS.map((item) => <AdminButton key={item.key} size="sm" variant={tab === item.key ? "primary" : "secondary"} aria-current={tab === item.key ? "page" : undefined} onClick={() => { setTab(item.key); setOrderId(null); setQueue([]); setBatch(null); setScanFeedback(null); setError("") }}>{item.label}</AdminButton>)}
    </nav>
    <p role="status" className="text-sm font-bold text-white">Lotes · {reviewCount} requiere revisión</p>
    {error && <div role="alert" className="rounded-xl border border-red-500/35 bg-red-950 p-3 text-sm text-white">{error}</div>}
    {loading && <p role="status" className="text-sm text-white/70">Cargando…</p>}

    {orderId ? <AdminSection compact className="dispatch-surface" title={orderCode(orderId)} eyebrow={queue.length > 1 ? `Armado · ${queueIndex + 1} de ${queue.length}` : "Armado"} actions={<AdminButton size="sm" onClick={closeOrder}>Volver</AdminButton>}>
      <OrderPreparationPanel key={orderId} orderId={orderId} onDone={nextInQueue ? undefined : closeOrder} footer={nextInQueue ? <AdminPrimaryButton className="h-12" onClick={() => setOrderId(nextInQueue)}>Siguiente pedido · {orderCode(nextInQueue)}</AdminPrimaryButton> : null} />
    </AdminSection> : batch ? <AdminSection compact className="dispatch-surface" title={batch.batch.code} eyebrow="Lote de envío" actions={<AdminButton size="sm" onClick={() => { setBatch(null); void refresh() }}>Volver</AdminButton>}>
      <div className="flex flex-wrap items-center gap-3"><AdminBadge tone={batch.batch.status === "handed_over" ? "success" : batch.blockedCount ? "warning" : "info"}>{batch.blockedCount ? "Requiere revisión" : batch.batch.status === "open" ? "Abierto" : batch.batch.status === "closed" ? "Lote cerrado" : "Entregado a Andreani"}</AdminBadge><span className="text-sm font-bold text-white">Pedidos: {batch.items.length} / Bultos: {batchParcels}</span><span className="text-sm text-white/70">{batch.batch.status === "open" ? `Escaneados: ${batch.scannedParcelCount ?? 0}/${batchParcels} · ` : ""}{batch.blockedCount} bloqueados {batch.blockedCount === 0 ? "✅" : ""}</span></div>
      {batch.blockedCount > 0 && <button type="button" className="mt-3 rounded-lg border border-red-500/50 bg-red-950 px-3 py-2 text-sm font-bold text-white" onClick={() => document.querySelector('[data-dispatch-blocked="true"]')?.scrollIntoView({ behavior: "smooth" })}>Revisar bloqueados</button>}
      {batch.batch.status === "handed_over" && <p role="status" className="mt-3 text-sm font-bold text-emerald-300">✓ Lote entregado a Andreani · {dateTime(batch.batch.handed_over_at)}{batch.operatorName ? ` · ${batch.operatorName}` : ""}</p>}
      {batch.batch.status === "open" && <form onSubmit={submitParcelScan} className="mt-4 flex flex-col gap-2 sm:flex-row">
        <label className="relative min-w-0 flex-1"><ScanLine className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-beyonix-sky" /><input ref={scanRef} aria-label="Escanear bulto" autoFocus autoComplete="off" value={parcelScan} onChange={(event) => { setParcelScan(event.target.value); scanKey.current = null }} placeholder="Escaneá la etiqueta del bulto (BX-PKG-…)" className="admin-control-input admin-ds-control h-14 w-full min-w-0 pl-12 pr-4 text-lg text-white outline-none" /></label>
        <AdminPrimaryButton type="submit" className="h-14 px-6 text-base" disabled={busy || !parcelScan.trim()}>Verificar bulto</AdminPrimaryButton>
      </form>}
      {scanFeedback && <p role="status" className={`mt-2 flex items-center gap-2 text-base font-bold ${scanFeedback.tone === "success" ? "text-emerald-300" : "text-red-300"}`}>{scanFeedback.tone === "success" ? <CheckCircle2 className="size-5" /> : <XCircle className="size-5" />}{scanFeedback.message}</p>}
      {batch.items.length > 0 && <div className="mt-4 space-y-2">{batch.items.map((item) => {
        const parcels = item.parcels ?? []
        const complete = Boolean(item.parcelCount) && item.scannedParcels === item.parcelCount
        return <AdminCard key={item.id} data-dispatch-blocked={item.blocked ? "true" : undefined} className={`dispatch-card flex flex-wrap items-center justify-between gap-3 p-3 ${item.blocked ? "border-red-500/50 bg-red-950" : ""}`}>
          <div className="min-w-0"><Link href={`/admin/pedidos/${item.order_id}`} className="font-bold text-white underline">{orderCode(item.order_id)}</Link><span className="ml-3 text-xs text-white/70">{item.parcelCount ? `${batch.batch.status === "open" ? `${item.scannedParcels}/` : ""}${item.parcelCount} ${item.parcelCount === 1 ? "bulto" : "bultos"}` : "Bultos sin definir"}</span>
            {item.blocked && <p role="alert" className="mt-1 text-xs font-bold text-white">Pedido bloqueado · {item.blockReason ?? "Revisión requerida"}</p>}
            {item.blocked && parcels.length > 0 && <p className="mt-1 text-xs text-white/80">Separá: {parcels.map((parcel) => parcel.barcode).join(", ")}</p>}
          </div>
          <div className="flex items-center gap-2"><AdminBadge tone={item.blocked ? "danger" : complete || batch.batch.status !== "open" ? "success" : "warning"}>{item.blocked ? "RETIRAR DEL DESPACHO" : complete || batch.batch.status !== "open" ? "Completo" : `Faltan ${Math.max(0, (item.parcelCount ?? 0) - item.scannedParcels)}`}</AdminBadge>{batch.batch.status !== "handed_over" && <AdminButton size="sm" variant="ghost" onClick={() => { setRemoveOrderId(item.order_id); setReason(""); setDialog("remove") }}>Retirar</AdminButton>}</div>
        </AdminCard>
      })}</div>}
      {batch.batch.status === "open" && <div className="mt-5 space-y-4">
        <AdminPrimaryButton className="h-12 text-base" disabled={busy || liveUpdating || !batchComplete || batch.blockedCount > 0} onClick={() => setDialog("close")}>CERRAR LOTE</AdminPrimaryButton>
        {!batchComplete && batch.items.length > 0 && <p className="text-sm text-amber-300">Escaneá todos los bultos para cerrar el lote.</p>}
        {batch.blockedCount > 0 && <p role="alert" className="text-sm text-amber-300">{orderCode(batch.items.find((item) => item.blocked)?.order_id ?? 0)} requiere revisión antes del despacho.</p>}
        <details className="text-sm text-white/70"><summary className="cursor-pointer">Agregar pedido completo por número</summary><form onSubmit={submitOrderSearch} className="mt-2 flex flex-col gap-2 sm:flex-row"><div className="flex-1"><AdminTextInput title="Agregar pedido" value={searchOrder} onChange={setSearchOrder} placeholder="BX-1031" /></div><AdminButton type="submit" disabled={busy || !searchOrder.trim()}>Agregar pedido</AdminButton></form></details>
      </div>}
      {batch.batch.status !== "open" && <><DispatchLabel batch={batch.batch} orderCount={batch.items.length} parcelCount={batchParcels} barcodeUrl={barcodeUrl} /><div className="mt-4 flex flex-wrap gap-2"><AdminButton icon={<Printer className="size-4" />} onClick={() => setDialog("label")}>Imprimir etiqueta del lote</AdminButton>{batch.batch.status === "closed" && <AdminPrimaryButton icon={<Truck className="size-4" />} disabled={busy || liveUpdating || Boolean(error) || batch.blockedCount > 0} onClick={() => setDialog("handover")}>Confirmar entrega a Andreani</AdminPrimaryButton>}</div>{batch.blockedCount > 0 && batch.batch.status === "closed" && <p role="alert" className="mt-3 text-sm text-amber-300">{orderCode(batch.items.find((item) => item.blocked)?.order_id ?? 0)} requiere revisión antes del despacho.</p>}</>}
    </AdminSection> : <AdminSection compact className="dispatch-surface" title={TABS.find((item) => item.key === tab)?.label ?? "Despachos"} icon={<PackageCheck className="size-4" />} actions={tab === "ready" ? <AdminPrimaryButton disabled={busy || selectedReady.length === 0} onClick={createLot}>CREAR LOTE DE ENVÍO{selectedReady.length ? ` · ${selectedReady.length}` : ""}</AdminPrimaryButton> : tab === "armado" && armadoSelected.size > 0 ? <AdminPrimaryButton onClick={() => startArmado(armadoOrders.filter((item) => armadoSelected.has(item.id)).map((item) => item.id))}>Armar seleccionados · {armadoSelected.size}</AdminPrimaryButton> : undefined}>
      {(tab === "armado" || tab === "ready") && <form onSubmit={submitOrderSearch} className="mb-4 flex flex-col gap-2 sm:flex-row"><div className="flex-1"><AdminTextInput title="Buscar pedido" value={searchOrder} onChange={setSearchOrder} placeholder="Buscar o escanear BX-1031" /></div><AdminButton type="submit" disabled={!searchOrder.trim()}>Abrir armado</AdminButton></form>}
      {tab === "ready" && readyOrders.length > 0 && <div className="mb-3 flex flex-wrap items-center gap-3 text-sm text-white/80"><label className="flex cursor-pointer items-center gap-2 font-bold"><input type="checkbox" className="size-5" checked={eligibleReady.length > 0 && selectedReady.length === eligibleReady.length} onChange={(event) => setAllSelected(event.target.checked ? eligibleReady.map((item) => item.id) : [])} />Seleccionar todos</label><span>Pedidos: {selectedReady.length} / Bultos: {selectedParcels}</span></div>}
      {(tab === "armado" || tab === "ready") ? (() => {
        const list = tab === "armado" ? armadoOrders : readyOrders
        return list.length ? <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{list.map((item) => {
          const stage = dispatchStage({ package: item.package, batchStatus: null })
          const checked = tab === "ready" ? selected.has(item.id) : armadoSelected.has(item.id)
          const disabled = tab === "ready" && Boolean(item.blocked)
          return <AdminCard key={item.id} interactive className={`dispatch-card flex items-center justify-between gap-2 ${item.blocked ? "border-red-500/40" : ""}`}>
            <label className={`flex min-w-0 flex-1 items-center gap-3 ${disabled ? "cursor-not-allowed" : "cursor-pointer"}`}>
              <input type="checkbox" className="size-5 shrink-0" aria-label={`Seleccionar ${orderCode(item.id)}`} checked={checked && !disabled} disabled={disabled} onChange={() => tab === "ready" ? toggleSelected(item.id) : setArmadoSelected((current) => { const next = new Set(current); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return next })} />
              <span className="min-w-0"><span className="block font-black text-white">{orderCode(item.id)}</span><span className="block text-xs text-white/60">{item.blocked ? `Bloqueado · ${item.blockReason ?? "Revisión requerida"}` : `${DISPATCH_STAGE_LABELS[stage]}${item.package?.parcel_count ? ` · ${item.package.parcel_count} ${item.package.parcel_count === 1 ? "bulto" : "bultos"}` : ""}`}</span></span>
            </label>
            <AdminButton size="sm" onClick={() => startArmado([item.id])}>{tab === "armado" ? "Armar" : "Ver"}</AdminButton>
          </AdminCard>
        })}</div> : <AdminEmptyState title="No hay pedidos en esta vista" description={tab === "armado" ? "Los pedidos pagos aparecerán acá para armarlos." : "Los pedidos con armado completo y bultos definidos aparecerán acá."} />
      })() : <>{shownBatches.length ? <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{shownBatches.map((item) => <AdminCard key={item.id} interactive className="dispatch-card flex items-center justify-between gap-2"><div><p className="font-black text-white">{item.code}</p><p className="text-xs text-white/60">Pedidos: {item.orderCount} / Bultos: {item.packageCount} · {item.blockedCount} bloqueados</p></div><AdminButton size="sm" onClick={() => void openBatch(item.id)}>Abrir</AdminButton></AdminCard>)}</div> : <AdminEmptyState title="No hay lotes en esta vista" description="Creá un lote desde Bultos listos." />}</>}
    </AdminSection>}

    <AdminModal open={dialog === "remove" || dialog === "close" || dialog === "handover"} title={dialog === "remove" ? "Retirar pedido del lote" : dialog === "close" ? "CERRAR LOTE" : "Confirmar entrega a Andreani"} description={dialog === "handover" ? `¿Confirmás que entregaste físicamente ${batch?.batch.code} a Andreani? Pedidos: ${batch?.items.length ?? 0} / Bultos: ${batchParcels}.` : dialog === "close" ? `${batch?.batch.code} · Pedidos: ${batch?.items.length ?? 0} / Bultos: ${batchParcels}. Se vuelve a validar pago, factura, envío y bloqueos de cada pedido.` : "Esta acción quedará registrada."} onClose={() => setDialog(null)} footer={<div className="flex justify-end gap-2"><AdminButton onClick={() => setDialog(null)}>Cancelar</AdminButton><AdminPrimaryButton disabled={busy || ((dialog === "handover" || dialog === "close") && (liveUpdating || Boolean(error) || Boolean(batch?.blockedCount))) || (dialog === "remove" && reason.trim().length < 10)} onClick={() => void run(async () => {
      if (dialog === "remove" && batch && removeOrderId) setBatch(await dispatchRequest<BatchDispatchDetail>(`/batches/${batch.batch.id}`, { action: "remove", orderId: removeOrderId, reason }))
      else if (dialog === "close" && batch) { setBatch(await dispatchRequest<BatchDispatchDetail>(`/batches/${batch.batch.id}`, { action: "close" })); setTab("closed") }
      else if (dialog === "handover" && batch) { setBatch(await dispatchRequest<BatchDispatchDetail>(`/batches/${batch.batch.id}`, { action: "handover" })); setTab("handed_over") }
      setDialog(null); setReason("")
    })}>{dialog === "handover" ? "Confirmar entrega" : dialog === "close" ? "Cerrar lote" : "Confirmar"}</AdminPrimaryButton></div>}>
      {dialog === "remove" && <AdminTextInput title="Motivo obligatorio" value={reason} onChange={setReason} placeholder="Ingresá el motivo (mínimo 10 caracteres)" />}
      {dialog === "handover" && <p className="text-sm text-white/70">Este paso registra el momento en que la mercadería salió físicamente de BEYONIX.</p>}
      {dialog === "close" && <p className="text-sm text-white/70">Al cerrar el lote queda registrado el corte de preparación: a partir de acá una cancelación no se reintegra automáticamente.</p>}
    </AdminModal>
    <LabelPrintDialog open={dialog === "label"} title="Etiqueta del lote" description={batch ? `${batch.batch.code} · Pedidos: ${batch.items.length} / Bultos: ${batchParcels}` : undefined} labels={batchLabel} onClose={() => setDialog(null)} />
  </div>
}
