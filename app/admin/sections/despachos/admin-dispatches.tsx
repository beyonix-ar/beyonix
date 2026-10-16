"use client"

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react"
import { AlertTriangle, Info, Layers, PackageCheck, PackageOpen, PackageX, RotateCcw, XCircle } from "lucide-react"

import {
  AdminBadge, AdminButton, AdminCard, AdminEmptyState,
  AdminPageHeader, AdminPrimaryButton, AdminSection, AdminTextInput,
  adminPageClassName,
} from "@/app/admin/components/admin-controls"
import { ADMIN_DISPATCH_CHANGED_EVENT } from "@/hooks/use-admin-notifications"
import { DISPATCH_STAGE_LABELS, dispatchStage, orderCode, readyForGeneralBundle, type BatchDispatchDetail, type DispatchBatch, type DispatchHold, type DispatchMembership, type DispatchOrder, type DispatchPackage } from "@/lib/admin/dispatch"
import { orderIdFromDispatchCode } from "@/lib/admin/dispatch-scan"
import { CancellationResolution } from "./cancellation-resolution"
import { DispatchProgress } from "./dispatch-progress"
import { dispatchRequest } from "./dispatch-request"
import { GeneralBundlePanel } from "./general-bundle-panel"
import { DISPATCH_STAGE_TONE, OrderPreparationPanel } from "./order-preparation-panel"

type Tab = "armado" | "ready" | "open" | "closed" | "handed_over"
type OrderCard = DispatchOrder & {
  package: DispatchPackage | null; membership: DispatchMembership | null; blocked?: boolean; blockReason?: string | null
  packingBlocked?: boolean; pendingBeforeDispatch?: string[]; itemCount?: number; units?: number; scannedUnits?: number
}
type BatchCard = DispatchBatch & { orderCount: number; verifiedCount?: number; packageCount: number; blockedCount: number }
type Board = { orders: OrderCard[]; batches: BatchCard[]; holds?: DispatchHold[] }

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
  { key: "armado", label: "Armado" }, { key: "ready", label: "Listos" },
  { key: "open", label: "Bultos generales abiertos" }, { key: "closed", label: "Cerrados" },
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
  const [selected, setSelected] = useState<Set<number>>(() => new Set())
  const [armadoSelected, setArmadoSelected] = useState<Set<number>>(() => new Set())
  const createKey = useRef<string | null>(null)
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
    setLoading(true); setError("")
    try { const detail = await dispatchRequest<BatchDispatchDetail>(`/batches/${id}`); setBatch(detail); setTab(detail.batch.status); setOrderId(null); setResolving(null) }
    catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo abrir el Bulto general.") }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { void refresh() }, [refresh])
  const activeBatchId = batch?.batch.id
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
          if (nextBatch) setBatch(nextBatch)
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

  async function run(action: () => Promise<void>) {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true); setError("")
    try { await action(); await refresh() }
    catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo completar la operación.") }
    finally { busyRef.current = false; setBusy(false) }
  }

  const orders = useMemo(() => board?.orders ?? [], [board])
  // Listo = preparado, identificado (BX-PREP) y con paquete de envío medido (Andreani).
  const readyOrders = orders.filter((item) => !item.membership && readyForGeneralBundle(item.package))
  const armadoOrders = orders.filter((item) => !item.membership && !readyForGeneralBundle(item.package))
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
    // Pedido (BX-1031), pedido preparado (BX-PREP-1031) o paquete de envío (BX-PKG-1031-01).
    const id = orderIdFromDispatchCode(searchOrder)
    if (!id) { setError("Ingresá o escaneá un pedido como BX-1031."); return }
    const hold = holds.find((item) => item.orderId === id)
    setSearchOrder("")
    if (hold) openResolution(hold)
    else startArmado([id])
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

  const queueIndex = orderId ? queue.indexOf(orderId) : -1
  const nextInQueue = queueIndex >= 0 ? queue[queueIndex + 1] : undefined
  const closeOrder = () => { setOrderId(null); setQueue([]); void refresh() }

  // Contadores sólo de las colas operativas: el board trae hasta 100 lotes,
  // así que cerrados/entregados no tendrían un total confiable.
  const openBatchCount = (board?.batches ?? []).filter((item) => item.status === "open").length
  const tabCounts: Partial<Record<Tab, number>> = board ? { armado: armadoOrders.length, ready: readyOrders.length, open: openBatchCount } : {}
  const actionCount = reviewCount + holds.filter((hold) => !hold.batchId).length
  const metrics: { label: string; value: number; icon: ReactNode; tone: "neutral" | "info" | "success" | "warning"; status?: string }[] = [
    { label: "En armado", value: armadoOrders.length, icon: <PackageOpen className="size-4" />, tone: "info" },
    { label: "Listos", value: readyOrders.length, icon: <PackageCheck className="size-4" />, tone: "success" },
    { label: "Bultos generales abiertos", value: openBatchCount, icon: <Layers className="size-4" />, tone: "info" },
    { label: "Requieren acción", value: actionCount, icon: <AlertTriangle className="size-4" />, tone: actionCount > 0 ? "warning" : "neutral", status: `Despachos · ${actionCount} requieren acción` },
  ]

  return <div className={`${adminPageClassName} dispatch-page mx-auto max-w-7xl`}>
    <div className="dispatch-workspace space-y-4 sm:space-y-5">
    <AdminPageHeader className="dispatch-header sm:flex-row sm:items-end sm:justify-between" eyebrow="Operación" title="Despachos" description="Prepará pedidos, identificalos, armá el Bulto general y confirmá la entrega física a Andreani." actions={<AdminButton onClick={() => void refresh()} disabled={loading || busy} icon={<RotateCcw className={`size-4 ${loading ? "animate-spin" : ""}`} />}>Actualizar</AdminButton>} />

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
      <div className="dispatch-metrics grid grid-cols-2 lg:grid-cols-4">
        {metrics.map((metric) => <div key={metric.label} role={metric.status ? "status" : undefined} aria-label={metric.status} className="dispatch-metric flex min-w-0 items-center gap-3 p-3">
          <span className={`admin-ds-badge admin-ds-tone-${metric.tone} flex size-9 shrink-0 items-center justify-center p-0`} aria-hidden="true">{metric.icon}</span>
          <span className="min-w-0">
            <span className="block truncate text-10px font-black uppercase tracking-widest text-white/60">{metric.label}</span>
            <span className="block text-xl font-black leading-tight tabular-nums text-white">{board ? metric.value : "—"}</span>
          </span>
        </div>)}
      </div>
      <nav aria-label="Estados de despacho" className="dispatch-tabs flex gap-1 overflow-x-auto p-1">
        {TABS.map((item) => {
          const active = tab === item.key && !resolving
          const count = tabCounts[item.key]
          return <button key={item.key} type="button" aria-current={active ? "page" : undefined} onClick={() => { setTab(item.key); setOrderId(null); setQueue([]); setBatch(null); setResolving(null); setError("") }} className={`inline-flex h-9 shrink-0 cursor-pointer items-center gap-2 rounded-lg border px-3 text-11px font-black uppercase tracking-wide transition-colors ${active ? "border-sky-400/50 bg-[#173b57] text-white" : "border-transparent text-white/60 hover:bg-white/5 hover:text-white"}`}>
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
    </AdminSection> : batch ? <AdminSection compact className="dispatch-surface" title={batch.batch.code} eyebrow="Bulto general" actions={<AdminButton size="sm" onClick={() => { setBatch(null); void refresh() }}>Volver</AdminButton>}>
      <GeneralBundlePanel key={batch.batch.id} detail={batch} holds={holds} liveUpdating={liveUpdating} boardError={Boolean(error)}
        onChange={(detail) => { setBatch(detail); setTab(detail.batch.status) }} onOpenResolution={openResolution} onRefresh={() => void refresh()} />
    </AdminSection> : <AdminSection compact className="dispatch-surface" title={TABS.find((item) => item.key === tab)?.label ?? "Despachos"} icon={<PackageCheck className="size-4" />} actions={tab === "ready" ? <AdminPrimaryButton className="w-full sm:w-auto" disabled={busy || selectedReady.length === 0} onClick={createLot}>CREAR BULTO GENERAL{selectedReady.length ? ` · ${selectedReady.length}` : ""}</AdminPrimaryButton> : tab === "armado" && armadoSelected.size > 0 ? <AdminPrimaryButton className="w-full sm:w-auto" onClick={() => startArmado(armadoOrders.filter((item) => armadoSelected.has(item.id)).map((item) => item.id))}>Armar seleccionados · {armadoSelected.size}</AdminPrimaryButton> : undefined}>
      {(tab === "armado" || tab === "ready") && <form onSubmit={submitOrderSearch} className="mb-4 flex flex-col gap-2 sm:flex-row"><div className="flex-1"><AdminTextInput title="Buscar pedido" value={searchOrder} onChange={setSearchOrder} placeholder="Buscar o escanear BX-1031" /></div><AdminButton type="submit" disabled={!searchOrder.trim()}>Abrir pedido</AdminButton></form>}
      {tab === "ready" && readyOrders.length > 0 && <div className="mb-3 flex flex-wrap items-center gap-3 text-sm text-white/80"><label className="flex cursor-pointer items-center gap-2 font-bold"><input type="checkbox" className="size-5" checked={eligibleReady.length > 0 && selectedReady.length === eligibleReady.length} onChange={(event) => setAllSelected(event.target.checked ? eligibleReady.map((item) => item.id) : [])} />Seleccionar todos</label><span>Pedidos: {selectedReady.length} / Paquetes: {selectedParcels}</span></div>}
      {(tab === "armado" || tab === "ready") ? (() => {
        const list = tab === "armado" ? armadoOrders : readyOrders
        return list.length ? <ul className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">{list.map((item) => <li key={item.id}><OrderQueueCard item={item} tab={tab}
          checked={tab === "ready" ? selected.has(item.id) : armadoSelected.has(item.id)}
          onToggle={() => tab === "ready" ? toggleSelected(item.id) : setArmadoSelected((current) => { const next = new Set(current); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return next })}
          onOpen={() => startArmado([item.id])} /></li>)}</ul>
          : <AdminEmptyState title="No hay pedidos en esta vista" description={tab === "armado" ? "Los pedidos pagos pendientes de preparar aparecerán acá, sin importar la fecha." : "Los pedidos preparados, identificados (BX-PREP) y con paquete de envío medido aparecerán acá."} />
      })() : <>{shownBatches.length ? <ul className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">{shownBatches.map((item) => <li key={item.id}><AdminCard interactive className={`dispatch-card flex items-center justify-between gap-3 p-3 ${item.blockedCount > 0 && item.status !== "handed_over" ? "border-amber-500/40" : ""}`}><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><p className="font-black text-white">{item.code}</p>{item.blockedCount > 0 && item.status !== "handed_over" ? <AdminBadge tone="warning">Requiere revisión</AdminBadge> : <AdminBadge tone={item.status === "handed_over" ? "success" : "info"}>{item.status === "open" ? "Abierto" : item.status === "closed" ? "Cerrado" : "Entregado"}</AdminBadge>}</div><p className="mt-1 text-xs text-white/60">{item.status === "handed_over" ? `${plural(item.orderCount, "pedido", "pedidos")}` : `Verificados: ${item.verifiedCount ?? 0} / ${item.orderCount}`} · {item.blockedCount} bloqueados</p></div><AdminButton size="sm" onClick={() => void openBatch(item.id)}>Abrir</AdminButton></AdminCard></li>)}</ul> : <AdminEmptyState title="No hay Bultos generales en esta vista" description="Creá uno desde Listos." />}</>}
    </AdminSection>}

    </div>
  </div>
}

/** Pedido en la cola de armado o listo para el Bulto general: identificación, estado, avance y acción. */
function OrderQueueCard({ item, tab, checked, onToggle, onOpen }: {
  item: OrderCard
  tab: "armado" | "ready"
  checked: boolean
  onToggle: () => void
  onOpen: () => void
}) {
  const stage = dispatchStage({ package: item.package, batchStatus: null })
  // En la cola de armado sólo bloquea lo que frena el pickeo; para el Bulto general, cualquier bloqueo.
  const blocked = tab === "ready" ? Boolean(item.blocked) : Boolean(item.packingBlocked ?? item.blocked)
  const disabled = tab === "ready" && blocked
  const pending = item.pendingBeforeDispatch ?? []
  const units = item.units ?? 0
  const started = Boolean(item.package)
  return <AdminCard interactive className={`dispatch-card dispatch-queue-card flex h-full flex-col gap-3 p-3 ${blocked ? "border-red-500/40" : checked ? "border-beyonix-sky/45" : ""}`}>
    <label className={`flex min-w-0 items-start gap-3 ${disabled ? "cursor-not-allowed" : "cursor-pointer"}`}>
      <input type="checkbox" className="mt-0.5 size-5 shrink-0" aria-label={`Seleccionar ${orderCode(item.id)}`} checked={checked && !disabled} disabled={disabled} onChange={onToggle} />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-black tabular-nums text-white">{orderCode(item.id)}</span>
          <AdminBadge tone={blocked ? "danger" : DISPATCH_STAGE_TONE[stage]}>{blocked ? "Requiere revisión" : DISPATCH_STAGE_LABELS[stage]}</AdminBadge>
        </span>
        <span className="mt-0.5 block truncate text-xs text-white/60">{dateTime(item.created_at)}{item.cliente_nombre ? ` · ${item.cliente_nombre}` : ""}</span>
        <span className="mt-1 block text-xs font-bold text-white/75">{plural(item.itemCount ?? 0, "producto", "productos")} · {plural(units, "unidad", "unidades")}{item.package?.parcel_count ? ` · ${plural(item.package.parcel_count, "paquete", "paquetes")}` : ""}</span>
      </span>
    </label>
    {tab === "armado" && started && units > 0 && <DispatchProgress compact done={item.scannedUnits ?? 0} total={units} unit="unidades" />}
    {blocked && <p className="flex items-start gap-1.5 text-xs font-bold text-red-200"><XCircle className="mt-0.5 size-3.5 shrink-0" />{item.blockReason ?? "Revisión requerida"}</p>}
    {!blocked && pending.length > 0 && <p className="flex items-start gap-1.5 text-xs text-sky-200"><Info className="mt-0.5 size-3.5 shrink-0" />{pending.join(" · ")}{tab === "armado" ? " — no frena la preparación" : ""}</p>}
    <AdminButton className="mt-auto h-11 w-full" variant={tab === "armado" && !blocked ? "primary" : "secondary"} onClick={onOpen}>{tab === "armado" ? started ? "Continuar armado" : "Armar" : "Ver pedido"}</AdminButton>
  </AdminCard>
}
