"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ArrowLeft, ArrowRight, CheckCircle2, PackageCheck, PackageX, RotateCcw } from "lucide-react"

import {
  AdminBadge, AdminButton, AdminCard, AdminEmptyState,
  AdminPageHeader, AdminPrimaryButton, AdminSection,
  adminPageClassName,
} from "@/app/admin/components/admin-controls"
import { ADMIN_DISPATCH_CHANGED_EVENT } from "@/hooks/use-admin-notifications"
import { andreaniShipmentCreated, DISPATCH_STAGE_LABELS, dispatchStage, orderCode, readyForGeneralBundle, type BatchDispatchDetail, type DispatchBatch, type DispatchHold, type DispatchMembership, type DispatchOrder, type DispatchPackage, type DispatchStage } from "@/lib/admin/dispatch"
import { dispatchBatchName, dispatchQueueStatus, selectVisibleOrders } from "@/lib/admin/dispatch-queue"
import { defaultDispatchFilters, dispatchFilterParams, dispatchPageCount, type DispatchBoardTab, type DispatchBoardFilters } from "@/lib/admin/dispatch-board-filters"
import { CancellationResolution } from "./cancellation-resolution"
import { DispatchFilterBar } from "./dispatch-filter-bar"
import { DeliveredBatchPanel } from "./delivered-batch-panel"
import { dispatchRequest } from "./dispatch-request"
import { GeneralBundlePanel } from "./general-bundle-panel"
import { DISPATCH_STAGE_TONE, OrderPreparationPanel } from "./order-preparation-panel"

type Tab = DispatchBoardTab
type OrderCard = DispatchOrder & {
  package: DispatchPackage | null; membership: DispatchMembership | null; blocked?: boolean; blockReason?: string | null
  packingBlocked?: boolean; pendingBeforeDispatch?: string[]; itemCount?: number; units?: number; scannedUnits?: number
  preparedByName?: string | null
}
type BatchCard = DispatchBatch & { orderCount: number; verifiedCount?: number; packageCount: number; blockedCount: number; removedCount?: number }
type Board = { orders: OrderCard[]; batches: BatchCard[]; holds?: DispatchHold[]; viewerRole?: string; total?: number; page?: number }

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
  return value ? new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", hourCycle: "h23", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)) : "—"
}
function shortDate(value: string) {
  return new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", hourCycle: "h23", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value))
}
const money = (value: number | null | undefined) => typeof value === "number" && Number.isFinite(value)
  ? new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 2 }).format(value) : "—"

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

const TABS: { key: Tab; label: string }[] = [
  { key: "armado", label: "Pendientes" }, { key: "ready", label: "Confirmados" },
  { key: "open", label: "Bultos" }, { key: "delivered", label: "Entregados" },
]

export function AdminDispatches({ initialBatchId, initialOrderId, initialResolveId }: { initialBatchId?: string; initialOrderId?: string; initialResolveId?: string }) {
  const [tab, setTab] = useState<Tab>(initialBatchId ? "open" : "armado")
  const [board, setBoard] = useState<Board | null>(null)
  const [orderId, setOrderId] = useState<number | null>(null)
  const [queue, setQueue] = useState<number[]>([])
  const [batch, setBatch] = useState<BatchDispatchDetail | null>(null)
  const [resolving, setResolving] = useState<DispatchHold | null>(null)
  const [resolutionReturnBatchId, setResolutionReturnBatchId] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [liveUpdating, setLiveUpdating] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [filtersByTab, setFiltersByTab] = useState<Record<Tab, DispatchBoardFilters>>(() => ({ armado: defaultDispatchFilters("armado"), ready: defaultDispatchFilters("ready"), open: defaultDispatchFilters("open"), delivered: defaultDispatchFilters("delivered") }))
  const [pages, setPages] = useState<Record<Tab, number>>({ armado: 1, ready: 1, open: 1, delivered: 1 })
  const [selected, setSelected] = useState<Set<number>>(() => new Set())
  const createKey = useRef<string | null>(null)
  const busyRef = useRef(false)
  const refreshVersion = useRef(0)
  const resolveHandled = useRef(false)

  useEffect(() => { setSelected(readSelection()) }, [])
  const filters = filtersByTab[tab]
  const query = dispatchFilterParams(tab, filters, pages[tab])
  const latestQuery = useRef(query)
  latestQuery.current = query

  const refresh = useCallback(async () => {
    const current = ++refreshVersion.current
    setLoading(true)
    try { const next = await dispatchRequest<Board>(`/search?${query}`); if (current === refreshVersion.current && query === latestQuery.current) { setBoard(next); setError("") } }
    catch (cause) { if (current === refreshVersion.current && query === latestQuery.current) setError(cause instanceof Error ? cause.message : "No se pudieron cargar los despachos.") }
    finally { if (current === refreshVersion.current && query === latestQuery.current) setLoading(false) }
  }, [query])

  const openBatch = useCallback(async (id: number) => {
    setLoading(true); setError("")
    try { const detail = await dispatchRequest<BatchDispatchDetail>(`/batches/${id}`); setBatch(detail); setTab(detail.batch.status === "handed_over" ? "delivered" : "open"); setOrderId(null); setResolving(null) }
    catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo abrir el Bulto general.") }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { const timer = setTimeout(() => void refresh(), /(?:search|operator|batch|sku|tracking)=/.test(query) ? 250 : 0); return () => clearTimeout(timer) }, [refresh, query])
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
            dispatchRequest<Board>(`/search?${query}`),
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
  }, [activeBatchId, query])
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
  const readyOrders = orders.filter((item) => dispatchQueueStatus(item) === "confirmed")
  const armadoOrders = orders.filter((item) => dispatchQueueStatus(item) === "pending")
  const eligibleReady = readyOrders.filter((item) => !item.blocked && readyForGeneralBundle(item.package, andreaniShipmentCreated(item)))
  const eligibleReadyIds = new Set(eligibleReady.map((item) => item.id))
  const visibleSelectableIds = readyOrders.filter((item) => eligibleReadyIds.has(item.id)).map((item) => item.id)
  const selectedReady = eligibleReady.filter((item) => selected.has(item.id))
  const shownBatches = (board?.batches ?? []).filter((item) => item.orderCount > 0)
  const total = board?.total ?? (tab === "open" || tab === "delivered" ? shownBatches.length : orders.length)
  const totalPages = dispatchPageCount(total)

  function toggleSelected(id: number) {
    createKey.current = null
    setSelected((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); writeSelection(next); return next })
  }
  function setAllSelected(ids: number[], checked: boolean) {
    createKey.current = null
    setSelected((current) => { const next = selectVisibleOrders(current, ids, checked); writeSelection(next); return next })
  }

  function startArmado(ids: number[]) {
    if (!ids.length) return
    setQueue(ids); setOrderId(ids[0]); setBatch(null); setResolving(null); setError(""); setNotice("")
  }

  function openResolution(hold: DispatchHold) {
    setResolutionReturnBatchId(batch?.batch.id ?? null)
    setResolving(hold); setOrderId(null); setQueue([]); setBatch(null); setError("")
  }
  function closeResolution() {
    setResolving(null)
    if (resolutionReturnBatchId) void openBatch(resolutionReturnBatchId)
    else void refresh()
    setResolutionReturnBatchId(null)
  }

  function createLot() {
    const orderIds = selectedReady.map((item) => item.id)
    if (!orderIds.length) return
    createKey.current ??= crypto.randomUUID()
    void run(async () => {
      const detail = await dispatchRequest<BatchDispatchDetail>("/batches", { requestKey: createKey.current, orderIds })
      createKey.current = null
      setAllSelected(orderIds, false)
      setBatch(detail); setTab("open")
    })
  }

  const queueIndex = orderId ? queue.indexOf(orderId) : -1
  const nextInQueue = queueIndex >= 0 ? queue[queueIndex + 1] : undefined
  const closeOrder = () => { setOrderId(null); setQueue([]); void refresh() }
  // Listado lateral: la cola elegida o los pedidos por preparar, siempre con el pedido actual.
  const baseSideIds = queue.length > 1 ? queue : armadoOrders.map((item) => item.id)
  const sideIds = orderId && !baseSideIds.includes(orderId) ? [orderId, ...baseSideIds] : baseSideIds

  // El total corresponde al filtro y la pestaña actuales, calculado en el servidor.
  const tabCounts: Partial<Record<Tab, number>> = board ? { [tab]: total } : {}

  return <div className={`${adminPageClassName} dispatch-page mx-auto max-w-6xl`}>
    <div className="dispatch-workspace space-y-4 sm:space-y-5">
    <AdminPageHeader className="dispatch-header sm:flex-row sm:items-end sm:justify-between" eyebrow="Operación" title="Despachos" description="Pickeá, confirmá el pedido y controlá los pedidos del Bulto." actions={<AdminButton onClick={() => void refresh()} disabled={loading || busy} icon={<RotateCcw className={`size-4 ${loading ? "animate-spin" : ""}`} />}>Actualizar</AdminButton>} />

    {holds.length > 0 && !resolving && !batch && (tab === "armado" || tab === "ready") && <section aria-label="Cancelaciones que requieren acción" className="space-y-2">
      {holds.map((hold) => <div key={hold.id} role="alert" className="flex flex-col gap-3 rounded-2xl border border-red-500/45 bg-red-950 p-3 sm:flex-row sm:items-center sm:justify-between sm:p-4">
        <div className="min-w-0">
          <p className="flex items-center gap-2 font-black text-white"><PackageX className="size-5 shrink-0 text-red-300" />Pedido {orderCode(hold.orderId)} cancelado</p>
          <p className="mt-0.5 text-sm text-white/80">{hold.prepared ? "Ya fue preparado físicamente" : `Ya tenía ${hold.pickedUnits} de ${hold.units} unidades pickeadas`}{hold.batchCode ? ` y está en ${hold.batchCode}` : ""}. Stock retenido · requiere resolución física · reintegro manual.</p>
        </div>
        <AdminPrimaryButton className="h-12 w-full shrink-0 sm:w-auto" onClick={() => openResolution(hold)}>ESCANEAR PEDIDO PARA LIBERAR STOCK</AdminPrimaryButton>
      </div>)}
    </section>}

    <div>
      <nav aria-label="Estados de despacho" className="dispatch-tabs flex gap-1 overflow-x-auto p-1">
        {TABS.map((item) => {
          const active = tab === item.key && !resolving
          const count = tabCounts[item.key]
          return <button key={item.key} type="button" aria-current={active ? "page" : undefined} onClick={() => { setTab(item.key); setOrderId(null); setQueue([]); setBatch(null); setResolving(null); setError(""); setNotice("") }} className={`inline-flex h-9 shrink-0 cursor-pointer items-center gap-2 rounded-lg border px-3 text-11px font-black uppercase tracking-wide transition-colors ${active ? "border-sky-400/50 bg-[#173b57] text-white" : "border-transparent text-white/60 hover:bg-white/5 hover:text-white"}`}>
            {item.label}
            {count !== undefined && <span className={`min-w-5 rounded-md px-1.5 py-0.5 text-center text-10px tabular-nums ${active ? "bg-white/15 text-white" : "bg-white/8 text-white/70"}`}>{count}</span>}
          </button>
        })}
      </nav>
    </div>
    {!orderId && !batch && !resolving && <DispatchFilterBar tab={tab} filters={filters} onChange={(patch) => { setFiltersByTab((current) => ({ ...current, [tab]: { ...current[tab], ...patch } })); setPages((current) => ({ ...current, [tab]: 1 })) }} onClear={() => { setFiltersByTab((current) => ({ ...current, [tab]: defaultDispatchFilters(tab) })); setPages((current) => ({ ...current, [tab]: 1 })) }} />}
    {error && <div role="alert" className="rounded-xl border border-red-500/35 bg-red-950 p-3 text-sm text-white">{error}</div>}
    {notice && <p role="status" className="flex items-start gap-2 text-sm font-bold text-emerald-300"><CheckCircle2 className="mt-0.5 size-4 shrink-0" />{notice}</p>}
    {loading && <p role="status" className="text-sm text-white/70">Cargando…</p>}

    {resolving ? <AdminSection compact className="dispatch-surface max-w-3xl" title={`Retirar ${orderCode(resolving.orderId)}`} eyebrow="Cancelación con armado" actions={<AdminButton size="sm" onClick={closeResolution}>Volver</AdminButton>}>
      <CancellationResolution key={resolving.id} hold={resolving} onResolved={() => void refresh()} onClose={closeResolution} />
    </AdminSection> : orderId ? <AdminSection compact className="dispatch-surface @container" title="Preparar pedido" eyebrow={queue.length > 1 ? `Pedido ${queueIndex + 1} de ${queue.length}` : "Despachos"} actions={<AdminButton size="sm" icon={<ArrowLeft className="size-4" />} onClick={closeOrder}>Volver</AdminButton>}>
      <div className={`grid gap-4 ${sideIds.length > 1 ? "@5xl:grid-cols-[220px_minmax(0,1fr)] @5xl:items-start" : ""}`}>
        {sideIds.length > 1 && <PreparationQueue className="order-last @5xl:order-first" title={queue.length > 1 ? "Pedidos seleccionados" : "Pedidos por preparar"} ids={sideIds} orders={orders} currentId={orderId}
          onSelect={(id) => { if (queue.length > 1) setOrderId(id); else startArmado([id]) }} />}
        <OrderPreparationPanel key={orderId} orderId={orderId} onDone={nextInQueue ? undefined : closeOrder}
          footer={nextInQueue ? <AdminButton className="h-11 w-full justify-center" icon={<ArrowRight className="size-4" />} onClick={() => setOrderId(nextInQueue)}>Siguiente pedido · {orderCode(nextInQueue)}</AdminButton> : null} />
      </div>
    </AdminSection> : batch ? <AdminSection compact className="dispatch-surface" title={dispatchBatchName(batch.batch)} eyebrow="Bulto general" actions={<AdminButton size="sm" onClick={() => { setBatch(null); void refresh() }}>Volver</AdminButton>}>
      {batch.batch.status === "handed_over" ? <DeliveredBatchPanel batchId={batch.batch.id} /> : <GeneralBundlePanel key={`${batch.batch.id}:${batch.blockedCount > 0 ? "problem" : "normal"}`} detail={batch} holds={holds} liveUpdating={liveUpdating} boardError={Boolean(error)}
        onChange={(detail) => { setBatch(detail); setTab("open") }} onOpenResolution={openResolution} onRefresh={() => void refresh()} />
      }
    </AdminSection> : <AdminSection compact className="dispatch-surface" title={TABS.find((item) => item.key === tab)?.label ?? "Despachos"} icon={<PackageCheck className="size-4" />}>
      {(tab === "armado" || tab === "ready") ? (() => {
        const pageItems = tab === "armado" ? armadoOrders : readyOrders
        return <>{pageItems.length ? <table className="dispatch-orders-table w-full" aria-label={tab === "armado" ? "Pedidos pendientes" : "Pedidos confirmados"}>
          <thead><tr>{tab === "ready" && <th scope="col"><input type="checkbox" aria-label="Seleccionar todos de esta página" checked={visibleSelectableIds.length > 0 && visibleSelectableIds.every((id) => selected.has(id))} disabled={visibleSelectableIds.length === 0} onChange={(event) => setAllSelected(visibleSelectableIds, event.target.checked)} /></th>}<th scope="col">Pedido</th><th scope="col">Fecha</th><th scope="col">Productos</th><th scope="col">Unidades</th><th scope="col">Estado</th><th scope="col">Total</th></tr></thead>
          <tbody>{pageItems.map((item) => <OrderQueueCard key={item.id} item={item} tab={tab} checked={selected.has(item.id)} onToggle={() => toggleSelected(item.id)} onOpen={() => startArmado([item.id])} />)}</tbody>
        </table>
          : <AdminEmptyState title="No hay pedidos en esta vista" description={tab === "armado" ? "Los pendientes siguen visibles aunque sean de días anteriores." : "Probá otra fecha o rango."} />}
          {tab === "ready" && <div className="dispatch-selection-footer mt-3 flex flex-wrap items-center justify-between gap-2"><span>{selectedReady.length} seleccionados</span><AdminPrimaryButton disabled={busy || selectedReady.length === 0} onClick={createLot}>Crear bulto</AdminPrimaryButton></div>}
          {totalPages > 1 && <DispatchPagination page={pages[tab]} pages={totalPages} onPage={(value) => setPages((current) => ({ ...current, [tab]: value }))} />}</>
      })() : <>{shownBatches.length ? <ul className="space-y-2">{shownBatches.map((item) => {
        const cancelled = holds.filter((hold) => hold.batchId === item.id).length
        const hasProblem = item.blockedCount > 0 && item.status !== "handed_over"
        const needsVerification = item.status === "closed" && item.verification_required !== false && (item.verifiedCount ?? 0) < item.orderCount
        const status = hasProblem
          ? cancelled > 0 ? cancelled === 1 ? "Tiene un pedido cancelado" : `Tiene ${cancelled} pedidos cancelados` : `${plural(item.blockedCount, "pedido", "pedidos")} por retirar`
          : item.status === "handed_over" ? "Entregado" : needsVerification ? "Faltan pedidos por controlar" : item.status === "open" ? "En armado" : "Listo para entregar"
        return <li key={item.id}><AdminCard interactive className={`dispatch-card dispatch-batch-list-card flex flex-wrap items-center justify-between gap-2 p-3 ${hasProblem ? "dispatch-batch-problem" : ""}`}>
          <div className="min-w-0"><p className="font-black text-white">{dispatchBatchName(item)}</p><p className="mt-0.5 text-xs text-white/70">{plural(item.orderCount, "pedido", "pedidos")} · <span className={hasProblem ? "text-red-300" : item.status === "closed" ? "text-emerald-300" : ""}>{status}</span>{item.status === "open" ? ` · Creado: ${dateTime(item.created_at)}` : item.status === "handed_over" ? ` · ${dateTime(item.handed_over_at)}` : ""}</p></div>
          <AdminButton size="sm" onClick={() => void openBatch(item.id)}>Abrir</AdminButton>
        </AdminCard></li>
      })}</ul> : <AdminEmptyState title={tab === "delivered" ? "No hay Bultos entregados en esta fecha" : "No hay Bultos generales en esta vista"} description={tab === "delivered" ? "Elegí otra fecha o rango." : "Creá uno desde Confirmados."} />}{totalPages > 1 && <DispatchPagination page={pages[tab]} pages={totalPages} onPage={(value) => setPages((current) => ({ ...current, [tab]: value }))} />}</>}
    </AdminSection>}

    </div>
  </div>
}

/** Próximo paso de un pedido en la cola, tal como lo muestra su acción principal. */
function DispatchPagination({ page, pages, onPage }: { page: number; pages: number; onPage: (page: number) => void }) {
  const first = Math.max(1, Math.min(page - 1, pages - 2))
  const numbers = Array.from({ length: Math.min(3, pages) }, (_, index) => first + index)
  return <nav aria-label="Páginas de pedidos" className="mt-4 flex flex-wrap items-center justify-center gap-1">
    <AdminButton size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>Anterior</AdminButton>
    {numbers.map((number) => <AdminButton key={number} size="sm" aria-current={number === page ? "page" : undefined} onClick={() => onPage(number)}>{number}</AdminButton>)}
    <AdminButton size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>Siguiente</AdminButton>
  </nav>
}

/** Una fila de pedido; el clic abre la preparación y el checkbox sólo selecciona. */
export function OrderQueueCard({ item, tab, checked, onToggle, onOpen }: {
  item: OrderCard
  tab: "armado" | "ready"
  checked: boolean
  onToggle: () => void
  onOpen: () => void
}) {
  const stage = dispatchStage({ package: item.package, shipmentCreated: andreaniShipmentCreated(item), batchStatus: null })
  // En la cola de preparación sólo bloquea lo que frena el pickeo; para el Bulto general, cualquier bloqueo.
  const blocked = tab === "ready" ? Boolean(item.blocked) : Boolean(item.packingBlocked ?? item.blocked)
  const selectable = tab === "ready" && !blocked && readyForGeneralBundle(item.package, andreaniShipmentCreated(item))
  const status = blocked ? item.cancelled_at ? "Cancelado" : "No puede continuar" : tab === "ready" ? "Confirmado" : stage === "pending" ? "Pendiente" : DISPATCH_STAGE_LABELS[stage]
  return <tr className="dispatch-order-row" tabIndex={0} aria-label={`Abrir pedido ${orderCode(item.id)}`} onClick={onOpen} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen() } }}>
    {tab === "ready" && <td className="dispatch-order-check" onClick={(event) => event.stopPropagation()}><input type="checkbox" className="size-5" aria-label={`Seleccionar ${orderCode(item.id)}`} checked={checked && selectable} disabled={!selectable} onChange={onToggle} onKeyDown={(event) => event.stopPropagation()} /></td>}
    <td className="dispatch-order-code" data-label="Pedido">{orderCode(item.id)}{item.preparedByName && <small className="block truncate font-normal opacity-75" title={`Preparó: ${item.preparedByName}`}>Preparó: {item.preparedByName}</small>}</td>
    <td className="dispatch-order-date" data-label="Fecha">{shortDate(tab === "ready" ? item.andreani_created_at || item.package?.prepared_at || item.created_at : item.created_at)}</td>
    <td className="dispatch-order-products" data-label="Productos">{item.itemCount ?? 0}<span className="dispatch-mobile-only"> productos</span></td>
    <td className="dispatch-order-units" data-label="Unidades">{item.units ?? 0}<span className="dispatch-mobile-only"> unidades</span></td>
    <td className="dispatch-order-status" data-label="Estado"><AdminBadge tone={blocked ? "danger" : DISPATCH_STAGE_TONE[stage]}>{status}</AdminBadge></td>
    <td className="dispatch-order-total" data-label="Total">{money(item.total)}</td>
  </tr>
}

const SHORT_STAGE: Partial<Record<DispatchStage, string>> = { pending: "Sin empezar", shipment: "Generar envío", label: "Imprimir etiqueta", ready: "Listo" }

/** Listado compacto de pedidos mientras se prepara uno: el actual queda marcado. */
function PreparationQueue({ ids, orders, currentId, title, className = "", onSelect }: {
  ids: number[]
  orders: OrderCard[]
  currentId: number
  title: string
  className?: string
  onSelect: (id: number) => void
}) {
  return <nav aria-label={title} className={`min-w-0 ${className}`}>
    <p className="dispatch-subheading mb-2">{title} <span>{ids.length}</span></p>
    <ul className="max-h-72 space-y-1 overflow-y-auto pr-1 @5xl:max-h-[70vh]">{ids.map((id) => {
      const item = orders.find((order) => order.id === id)
      const stage = item ? dispatchStage({ package: item.package, shipmentCreated: andreaniShipmentCreated(item), batchStatus: null }) : null
      const status = !item || !stage ? "" : stage === "packing" ? `${item.scannedUnits ?? 0} de ${item.units ?? 0} u.` : SHORT_STAGE[stage] ?? DISPATCH_STAGE_LABELS[stage]
      const current = id === currentId
      return <li key={id}><button type="button" aria-current={current ? "true" : undefined} onClick={() => { if (!current) onSelect(id) }} className="dispatch-queue-item">
        <span className="flex items-center justify-between gap-2"><span className="font-black tabular-nums">{orderCode(id)}</span><span className="shrink-0 text-11px font-bold opacity-75">{status}</span></span>
        {item?.cliente_nombre && <span className="block truncate text-xs opacity-60">{item.cliente_nombre}</span>}
      </button></li>
    })}</ul>
  </nav>
}
