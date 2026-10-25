"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ArrowLeft, ArrowRight, CheckCircle2, PackageCheck, PackageX, RotateCcw } from "lucide-react"

import {
  AdminButton, AdminEmptyState,
  AdminPageHeader, AdminPrimaryButton, AdminSection,
  adminPageClassName,
} from "@/app/admin/components/admin-controls"
import { ADMIN_DISPATCH_CHANGED_EVENT } from "@/hooks/use-admin-notifications"
import { holdBundleLabel, orderCode, type BatchDispatchDetail, type DispatchHold } from "@/lib/admin/dispatch"
import { dispatchBatchName } from "@/lib/admin/dispatch-queue"
import { batchStepFacts, getNextDispatchStep, type DispatchNextStep } from "@/lib/admin/dispatch-next-step"
import { clearedDispatchRecordFilters, defaultDispatchRecordFilters, dispatchPageCount, dispatchRecordParams, DISPATCH_VIEW_KEY, restoreDispatchRecordsView, type DispatchRecord, type DispatchRecordFilters, type DispatchUser } from "@/lib/admin/dispatch-records"
import { dispatchLocationFromSearch, dispatchLocationHref, parseCancellationReturn, parseDispatchLocation, type DispatchLocation } from "@/lib/admin/dispatch-location"
import { CancellationResolution } from "./cancellation-resolution"
import { DispatchFilterBar } from "./dispatch-filter-bar"
import { DispatchRecordsTable } from "./dispatch-records-table"
import { DeliveredBatchPanel } from "./delivered-batch-panel"
import { dispatchRequest } from "./dispatch-request"
import { GeneralBundlePanel } from "./general-bundle-panel"
import { OrderPreparationPanel } from "./order-preparation-panel"

type Board = { rows: DispatchRecord[]; total: number; page: number; holds: DispatchHold[]; users: DispatchUser[] }

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

function readView() {
  try { return restoreDispatchRecordsView(window.sessionStorage.getItem(DISPATCH_VIEW_KEY)) } catch { return restoreDispatchRecordsView(null) }
}

export function AdminDispatches({ initialBatchId, initialOrderId, initialResolveId, initialReturnTo }: { initialBatchId?: string; initialOrderId?: string; initialResolveId?: string; initialReturnTo?: string }) {
  // Llegada desde el asistente de cancelación: al terminar, vuelve al mismo paso.
  const returnOrderId = Number(initialResolveId)
  const returnTo = Number.isSafeInteger(returnOrderId) && returnOrderId > 0 && parseCancellationReturn(initialReturnTo) === `/admin/pedidos/${returnOrderId}?tab=cancelacion`
    ? `/admin/pedidos/${returnOrderId}?tab=cancelacion` : null
  const [returnReady, setReturnReady] = useState(false)
  // Pedido y Bulto abiertos viven en la URL (refrescar/volver/otra pestaña).
  const [location, setLocation] = useState<DispatchLocation>(() => parseDispatchLocation({ order: initialOrderId, batch: initialBatchId }))
  const [board, setBoard] = useState<Board | null>(null)
  const [loadedBatch, setBatch] = useState<BatchDispatchDetail | null>(null)
  const [batchReload, setBatchReload] = useState(0)
  const [resolving, setResolving] = useState<DispatchHold | null>(null)
  const [loading, setLoading] = useState(false)
  const [liveUpdating, setLiveUpdating] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [filters, setFilters] = useState<DispatchRecordFilters>(() => defaultDispatchRecordFilters())
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<Set<number>>(() => new Set())
  const createKey = useRef<string | null>(null)
  const busyRef = useRef(false)
  const refreshVersion = useRef(0)
  const resolveHandled = useRef(false)
  const viewRestored = useRef(false)
  // true = el detalle abierto se apiló desde la tabla: Volver = atrás del navegador.
  const pushedDetail = useRef(false)

  const orderId = location.orderId
  const batch = loadedBatch && loadedBatch.batch.id === location.batchId ? loadedBatch : null

  const navigate = useCallback((next: DispatchLocation, mode: "push" | "replace") => {
    const href = dispatchLocationHref(next)
    try { if (mode === "push") window.history.pushState(null, "", href); else window.history.replaceState(null, "", href) } catch { /* La vista igual se actualiza. */ }
    setLocation(next)
  }, [])
  useEffect(() => {
    const onPopState = () => { pushedDetail.current = false; setLocation(dispatchLocationFromSearch(window.location.search)) }
    window.addEventListener("popstate", onPopState)
    return () => window.removeEventListener("popstate", onPopState)
  }, [])

  // Filtros y página sobreviven a volver desde otra pantalla (el mismo día).
  useEffect(() => {
    if (!viewRestored.current) return
    try { window.sessionStorage.setItem(DISPATCH_VIEW_KEY, JSON.stringify({ filters, page, today: defaultDispatchRecordFilters().date })) } catch { /* Preferencia local opcional. */ }
  }, [filters, page])
  useEffect(() => {
    const view = readView()
    viewRestored.current = true
    setFilters(view.filters); setPage(view.page); setSelected(readSelection())
  }, [])
  const query = dispatchRecordParams(filters, page)
  const latestQuery = useRef(query)
  latestQuery.current = query

  const refresh = useCallback(async () => {
    const current = ++refreshVersion.current
    setLoading(true)
    try { const next = await dispatchRequest<Board>(`/search?${query}`); if (current === refreshVersion.current && query === latestQuery.current) { setBoard(next); setError("") } }
    catch (cause) { if (current === refreshVersion.current && query === latestQuery.current) setError(cause instanceof Error ? cause.message : "No se pudieron cargar los despachos.") }
    finally { if (current === refreshVersion.current && query === latestQuery.current) setLoading(false) }
  }, [query])

  const batchId = location.batchId
  useEffect(() => {
    if (!batchId) return
    let active = true
    setLoading(true); setError("")
    dispatchRequest<BatchDispatchDetail>(`/batches/${batchId}`)
      .then((detail) => { if (active) setBatch(detail) })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : "No se pudo abrir el Bulto general.") })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [batchId, batchReload])

  useEffect(() => { const timer = setTimeout(() => void refresh(), /(?:order|batch)=/.test(query) ? 250 : 0); return () => clearTimeout(timer) }, [refresh, query])
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
  const holds = useMemo(() => board?.holds ?? [], [board])  // Acceso directo desde la alerta: /admin/despachos?resolve=<pedido>.
  useEffect(() => {
    if (resolveHandled.current || !board) return
    const id = Number(initialResolveId)
    if (!Number.isSafeInteger(id) || id <= 0) return
    resolveHandled.current = true
    const hold = holds.find((item) => item.orderId === id)
    if (hold) setResolving(hold)
    // Ya resuelta (otro dispositivo, o volver/recargar después del escaneo).
    else if (returnTo) setReturnReady(true)
  }, [board, holds, initialResolveId, returnTo])

  async function run(action: () => Promise<void>) {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true); setError("")
    try { await action(); await refresh() }
    catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo completar la operación.") }
    finally { busyRef.current = false; setBusy(false) }
  }

  const rows = useMemo(() => board?.rows ?? [], [board])
  const selectedOrders = rows.filter((row) => row.kind === "order" && row.selectable && selected.has(row.id))
  const canCreateBundle = rows.some((row) => row.selectable)
  const totalPages = dispatchPageCount(board?.total ?? 0)
  // Mientras se prepara un pedido, al costado quedan los pendientes de la tabla.
  const pendingIds = rows.filter((row) => row.kind === "order" && row.state === "P").map((row) => row.id)
  const sideIds = orderId && !pendingIds.includes(orderId) ? [orderId, ...pendingIds] : pendingIds
  const nextPending = orderId ? sideIds[sideIds.indexOf(orderId) + 1] : undefined

  function changeFilters(patch: Partial<DispatchRecordFilters>) {
    setFilters((current) => ({ ...current, ...patch })); setPage(1)
  }
  function toggleSelected(id: number) {
    createKey.current = null
    setSelected((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); writeSelection(next); return next })
  }
  function clearSelected(ids: number[]) {
    createKey.current = null
    setSelected((current) => { const next = new Set(current); for (const id of ids) next.delete(id); writeSelection(next); return next })
  }

  /** Abre un pedido o un Bulto: desde la tabla se apila (Atrás vuelve a la tabla); entre detalles se reemplaza. */
  function openDetail(next: { orderId?: number; batchId?: number }) {
    const fromList = !location.orderId && !location.batchId
    navigate({ orderId: next.orderId ?? null, batchId: next.batchId ?? null }, fromList ? "push" : "replace")
    if (fromList) pushedDetail.current = true
    setResolving(null); setError(""); setNotice("")
  }
  function openRecord(record: DispatchRecord) {
    if (record.kind === "order") openDetail({ orderId: record.id })
    else openDetail({ batchId: record.id })
  }
  /** Tabla: si el detalle se apiló desde ella, Atrás (no queda una entrada que repita nada); si no, reemplaza. */
  function showList() {
    if (pushedDetail.current) { pushedDetail.current = false; window.history.back() }
    else navigate({ orderId: null, batchId: null }, "replace")
  }
  /** Volver a la tabla con sus filtros y página. */
  function closeDetail() {
    setError(""); setNotice("")
    showList()
    void refresh()
  }
  /** Siguiente pantalla tras una confirmación ya guardada (getNextDispatchStep decide cuál). */
  function advance(step: DispatchNextStep) {
    if (step.screen === "current") return
    if (step.screen === "batch") {
      if (step.batchId !== location.batchId) openDetail({ batchId: step.batchId })
      return
    }
    const finished = batch
    setResolving(null); setError("")
    showList()
    // Tabla general del día (pedidos y Bultos): pendientes y confirmados siguen visibles en cualquier fecha.
    setFilters(defaultDispatchRecordFilters()); setPage(1)
    if (step.screen === "bundle_list") {
      createKey.current = null
      setSelected((current) => { const next = new Set(current); next.add(step.orderId); writeSelection(next); return next })
      setNotice(`Etiqueta confirmada · ${orderCode(step.orderId)} listo para Bulto. Seguí con otro pedido o tocá "Crear bulto".`)
    } else {
      setNotice(finished ? `${dispatchBatchName(finished.batch)} despachado.` : "Confirmado.")
    }
    void refresh()
  }

  function openResolution(hold: DispatchHold) {
    setResolving(hold); setError("")
  }
  function closeResolution() {
    setResolving(null)
    if (batch) setBatchReload((value) => value + 1)
    else void refresh()
  }

  function createLot() {
    const orderIds = selectedOrders.map((item) => item.id)
    if (!orderIds.length) return
    createKey.current ??= crypto.randomUUID()
    void run(async () => {
      const detail = await dispatchRequest<BatchDispatchDetail>("/batches", { requestKey: createKey.current, orderIds })
      createKey.current = null
      clearSelected(orderIds)
      setBatch(detail); advance(getNextDispatchStep(batchStepFacts(detail)))
    })
  }

  const listView = !orderId && !location.batchId && !resolving

  return <div className={`${adminPageClassName} dispatch-page mx-auto max-w-6xl`}>
    <div className="dispatch-workspace space-y-4 sm:space-y-5">
    <AdminPageHeader className="dispatch-header sm:flex-row sm:items-end sm:justify-between" eyebrow="Operación" title="Despachos" description="Pedidos y Bultos del día: pickeá, confirmá, armá el Bulto y entregalo." actions={<AdminButton onClick={() => void refresh()} disabled={loading || busy} icon={<RotateCcw className={`size-4 ${loading ? "animate-spin" : ""}`} />}>Actualizar</AdminButton>} />

    {returnTo && <section aria-label="Cancelación en curso" className="flex flex-col gap-3 rounded-2xl border border-white/15 bg-white/5 p-3 sm:flex-row sm:items-center sm:justify-between sm:p-4">
      <p className="flex items-center gap-2 text-sm font-bold text-white">{returnReady
        ? <><CheckCircle2 className="size-5 shrink-0 text-emerald-300" />Mercadería de {orderCode(returnOrderId)} resuelta.</>
        : <>Cancelación de {orderCode(returnOrderId)}: devolvé la mercadería al stock y volvé al pedido.</>}</p>
      <a href={returnTo} className="admin-ds-button admin-ds-button-primary inline-flex h-11 shrink-0 items-center justify-center gap-2 px-4 text-xs font-black uppercase tracking-wide">Continuar cancelación <ArrowRight className="size-4" /></a>
    </section>}

    {holds.length > 0 && listView && <section aria-label="Cancelaciones que requieren acción" className="space-y-2">
      {holds.map((hold) => <div key={hold.id} role="alert" className="flex flex-col gap-3 rounded-2xl border border-red-500/45 bg-red-950 p-3 sm:flex-row sm:items-center sm:justify-between sm:p-4">
        <div className="min-w-0">
          <p className="flex items-center gap-2 font-black text-white"><PackageX className="size-5 shrink-0 text-red-300" />Pedido {orderCode(hold.orderId)} cancelado</p>
          <p className="mt-0.5 text-sm text-white/80">{hold.prepared ? "Ya fue preparado físicamente" : `Ya tenía ${hold.pickedUnits} de ${hold.units} unidades pickeadas`}{hold.batchCode ? `. Retiralo del ${holdBundleLabel(hold.batchCode)} antes de entregarlo` : ""}. El stock vuelve al escanear el pedido.</p>
        </div>
        <AdminPrimaryButton className="h-12 w-full shrink-0 sm:w-auto" onClick={() => openResolution(hold)}>ESCANEAR PEDIDO PARA LIBERAR STOCK</AdminPrimaryButton>
      </div>)}
    </section>}

    {listView && <DispatchFilterBar filters={filters} users={board?.users ?? []} onChange={changeFilters} onClear={() => { setFilters(clearedDispatchRecordFilters()); setPage(1) }} />}
    {error && <div role="alert" className="rounded-xl border border-red-500/35 bg-red-950 p-3 text-sm text-white">{error}</div>}
    {notice && <p role="status" className="flex items-start gap-2 text-sm font-bold text-emerald-300"><CheckCircle2 className="mt-0.5 size-4 shrink-0" />{notice}</p>}
    {loading && <p role="status" className="text-sm text-white/70">Cargando…</p>}

    {resolving ? <AdminSection compact className="dispatch-surface max-w-3xl" title={`Retirar ${orderCode(resolving.orderId)}`} eyebrow="Cancelación con armado" actions={<AdminButton size="sm" onClick={closeResolution}>Volver</AdminButton>}>
      <CancellationResolution key={resolving.id} hold={resolving} onResolved={(result) => { if (result.orderId === returnOrderId) setReturnReady(true); void refresh() }} onClose={closeResolution} />
    </AdminSection> : orderId ? <AdminSection compact className="dispatch-surface @container" title="Preparar pedido" eyebrow="Despachos" actions={<AdminButton size="sm" icon={<ArrowLeft className="size-4" />} onClick={closeDetail}>Volver</AdminButton>}>
      <div className={`grid gap-4 ${sideIds.length > 1 ? "@5xl:grid-cols-[220px_minmax(0,1fr)] @5xl:items-start" : ""}`}>
        {sideIds.length > 1 && <PreparationQueue className="order-last @5xl:order-first" title="Pedidos por preparar" ids={sideIds} currentId={orderId}
          onSelect={(id) => openDetail({ orderId: id })} />}
        <OrderPreparationPanel key={orderId} orderId={orderId} onDone={nextPending ? undefined : closeDetail} onAdvance={advance}
          footer={nextPending ? <AdminButton className="h-11 w-full justify-center" icon={<ArrowRight className="size-4" />} onClick={() => openDetail({ orderId: nextPending })}>Siguiente pedido · {orderCode(nextPending)}</AdminButton> : null} />
      </div>
    </AdminSection> : batch ? <AdminSection compact className="dispatch-surface" title={dispatchBatchName(batch.batch)} eyebrow={batch.batch.status === "handed_over" ? "Despachado" : "Bulto general"} actions={<AdminButton size="sm" icon={<ArrowLeft className="size-4" />} onClick={closeDetail}>Volver</AdminButton>}>
      {batch.batch.status === "handed_over" ? <DeliveredBatchPanel batchId={batch.batch.id} /> : <GeneralBundlePanel key={`${batch.batch.id}:${batch.blockedCount > 0 ? "problem" : "normal"}`} detail={batch} holds={holds} liveUpdating={liveUpdating} boardError={Boolean(error)}
        onChange={setBatch} onOpenResolution={openResolution} onRefresh={() => void refresh()} onAdvance={advance} />
      }
    </AdminSection> : location.batchId ? (error ? null : <p role="status" className="text-sm text-white/70">Abriendo Bulto…</p>) : <AdminSection compact className="dispatch-surface" title="Pedidos y Bultos" icon={<PackageCheck className="size-4" />}>
      {rows.length ? <DispatchRecordsTable rows={rows} selected={selected} onToggle={toggleSelected} onOpen={openRecord} />
        : board && <AdminEmptyState title="No hay registros con estos filtros" description="Elegí otra fecha o limpiá los filtros." />}
      {canCreateBundle && <div className="dispatch-selection-footer mt-3 flex flex-wrap items-center justify-between gap-2"><span>{selectedOrders.length} seleccionados</span><AdminPrimaryButton disabled={busy || selectedOrders.length === 0} onClick={createLot}>Crear bulto</AdminPrimaryButton></div>}
      {totalPages > 1 && <DispatchPagination page={page} pages={totalPages} onPage={setPage} />}
    </AdminSection>}

    </div>
  </div>
}

function DispatchPagination({ page, pages, onPage }: { page: number; pages: number; onPage: (page: number) => void }) {
  const first = Math.max(1, Math.min(page - 1, pages - 2))
  const numbers = Array.from({ length: Math.min(3, pages) }, (_, index) => first + index)
  return <nav aria-label="Páginas de despachos" className="mt-4 flex flex-wrap items-center justify-center gap-1">
    <AdminButton size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>Anterior</AdminButton>
    {numbers.map((number) => <AdminButton key={number} size="sm" aria-current={number === page ? "page" : undefined} onClick={() => onPage(number)}>{number}</AdminButton>)}
    <AdminButton size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>Siguiente</AdminButton>
  </nav>
}

/** Listado compacto de pedidos mientras se prepara uno: el actual queda marcado. */
function PreparationQueue({ ids, currentId, title, className = "", onSelect }: {
  ids: number[]
  currentId: number
  title: string
  className?: string
  onSelect: (id: number) => void
}) {
  return <nav aria-label={title} className={`min-w-0 ${className}`}>
    <p className="dispatch-subheading mb-2">{title} <span>{ids.length}</span></p>
    <ul className="max-h-72 space-y-1 overflow-y-auto pr-1 @5xl:max-h-[70vh]">{ids.map((id) => {
      const current = id === currentId
      return <li key={id}><button type="button" aria-current={current ? "true" : undefined} onClick={() => { if (!current) onSelect(id) }} className="dispatch-queue-item">
        <span className="font-black tabular-nums">{orderCode(id)}</span>
      </button></li>
    })}</ul>
  </nav>
}
