"use client"

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react"
import Link from "next/link"
import { PackageCheck, Printer, RotateCcw, Truck } from "lucide-react"

import {
  AdminBadge, AdminButton, AdminCard, AdminEmptyState, AdminModal,
  AdminPageHeader, AdminPrimaryButton, AdminSection, AdminTextInput,
  adminPageClassName,
} from "@/app/admin/components/admin-controls"
import { supabase } from "@/lib/supabase/client"
import { orderCode, parseOrderCode, type DispatchBatch, type DispatchLine, type DispatchMembership, type DispatchOrder, type DispatchPackage } from "@/lib/admin/dispatch"
import { DispatchLabel } from "./dispatch-label"

type Tab = "preparing" | "ready" | "open" | "closed" | "handed_over"
type OrderCard = DispatchOrder & { package: DispatchPackage | null; membership: DispatchMembership | null }
type BatchCard = DispatchBatch & { orderCount: number; packageCount: number; blockedCount: number }
type Board = { orders: OrderCard[]; batches: BatchCard[] }
type OrderDetail = { order: DispatchOrder; package: DispatchPackage | null; lines: DispatchLine[]; itemCount: number; expectedUnits: number; membership: DispatchMembership | null; batch: DispatchBatch | null; blocked: boolean }
type BatchDetail = { batch: DispatchBatch; items: (DispatchMembership & { blocked: boolean })[]; blockedCount: number; operatorName: string | null }

async function dispatchRequest<T>(path: string, body?: object): Promise<T> {
  const { data } = await supabase.auth.getSession()
  if (!data.session?.access_token) throw new Error("Tu sesión venció. Volvé a ingresar.")
  const response = await fetch(`/api/admin/dispatch${path}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${data.session.access_token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null
    throw new Error(payload?.error ?? "No se pudo completar la operación. Reintentá.")
  }
  return response.json() as Promise<T>
}

function dateTime(value: string | null) {
  return value ? new Intl.DateTimeFormat("es-AR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)) : "—"
}

const TABS: { key: Tab; label: string }[] = [
  { key: "preparing", label: "Preparando" }, { key: "ready", label: "Listos" },
  { key: "open", label: "Tandas abiertas" }, { key: "closed", label: "Tandas cerradas" },
  { key: "handed_over", label: "Entregadas" },
]

export function AdminDispatches({ initialBatchId, initialOrderId }: { initialBatchId?: string; initialOrderId?: string }) {
  const [tab, setTab] = useState<Tab>(initialBatchId ? "closed" : "preparing")
  const [board, setBoard] = useState<Board | null>(null)
  const [order, setOrder] = useState<OrderDetail | null>(null)
  const [batch, setBatch] = useState<BatchDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [feedback, setFeedback] = useState("")
  const [scan, setScan] = useState("")
  const [searchOrder, setSearchOrder] = useState("")
  const [reason, setReason] = useState("")
  const [dialog, setDialog] = useState<"reset" | "remove" | "handover" | null>(null)
  const [removeOrderId, setRemoveOrderId] = useState<number | null>(null)
  const [barcodeUrl, setBarcodeUrl] = useState<string | null>(null)
  const scanKey = useRef<string | null>(null)
  const createKey = useRef<string | null>(null)
  const resetKey = useRef<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try { setBoard(await dispatchRequest<Board>("")); setError("") }
    catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudieron cargar los despachos.") }
    finally { setLoading(false) }
  }, [])

  const openOrder = useCallback(async (id: number) => {
    setLoading(true); setError(""); setFeedback("")
    try { setOrder(await dispatchRequest<OrderDetail>(`/orders/${id}`)); setBatch(null) }
    catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo abrir el pedido.") }
    finally { setLoading(false) }
  }, [])

  const openBatch = useCallback(async (id: number) => {
    setLoading(true); setError(""); setFeedback("")
    try { const detail = await dispatchRequest<BatchDetail>(`/batches/${id}`); setBatch(detail); setTab(detail.batch.status); setOrder(null) }
    catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo abrir la tanda.") }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    const id = Number(initialOrderId)
    if (Number.isSafeInteger(id) && id > 0) void openOrder(id)
    else if (initialBatchId) {
      const batchId = Number(initialBatchId)
      if (Number.isSafeInteger(batchId) && batchId > 0) void openBatch(batchId)
    }
  }, [initialBatchId, initialOrderId, openBatch, openOrder])

  useEffect(() => {
    if (!batch || batch.batch.status === "open") { setBarcodeUrl(null); return }
    let cancelled = false
    let objectUrl: string | null = null
    void (async () => {
      try {
        const { data } = await supabase.auth.getSession()
        if (!data.session) return
        const response = await fetch(`/api/admin/dispatch/batches/${batch.batch.id}/barcode`, { headers: { Authorization: `Bearer ${data.session.access_token}` }, cache: "no-store" })
        if (!response.ok) return
        objectUrl = URL.createObjectURL(await response.blob())
        if (!cancelled) setBarcodeUrl(objectUrl)
      } catch { /* La tanda sigue disponible aunque la etiqueta no cargue. */ }
    })()
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); setBarcodeUrl(null) }
  }, [batch])

  async function run(action: () => Promise<void>) {
    if (busy) return
    setBusy(true); setError("")
    try { await action(); await refresh() }
    catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo completar la operación.") }
    finally { setBusy(false) }
  }

  function submitScan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!order || !scan.trim()) return
    const code = scan.trim()
    scanKey.current ??= crypto.randomUUID()
    void run(async () => {
      const updated = await dispatchRequest<OrderDetail>(`/orders/${order.order.id}`, { action: "scan", code, requestKey: scanKey.current })
      setOrder(updated)
      const line = updated.lines.find((item) => item.expected_barcode === code || item.expected_sku === code.toUpperCase())
      setFeedback(line ? `✓ ${line.name} · ${line.scanned_quantity} de ${line.expected_quantity}` : "✓ Producto verificado")
      setScan(""); scanKey.current = null
      inputRef.current?.focus()
    })
  }

  function submitOrderSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const id = parseOrderCode(searchOrder)
    if (!id) { setError("Ingresá un pedido como BX-1031."); return }
    if (!batch) { void openOrder(id); return }
    void run(async () => { setBatch(await dispatchRequest<BatchDetail>(`/batches/${batch.batch.id}`, { action: "add", orderId: id })); setSearchOrder("") })
  }

  const shownOrders = (board?.orders ?? []).filter((item) => tab === "preparing" ? !item.package || item.package.status === "preparing" : item.package?.status === "prepared" && !item.membership)
  const shownBatches = (board?.batches ?? []).filter((item) => item.status === tab)
  const completed = order?.package?.status === "prepared"

  return <div className={`${adminPageClassName} mx-auto max-w-7xl`}>
    <AdminPageHeader eyebrow="Operación" title="Despachos" description="Prepará pedidos, armá tandas y confirmá la entrega física." actions={<AdminButton onClick={() => void refresh()} disabled={loading || busy} icon={<RotateCcw className="size-4" />}>Actualizar</AdminButton>} />
    <nav aria-label="Estados de despacho" className="flex flex-wrap gap-2">
      {TABS.map((item) => <AdminButton key={item.key} size="sm" variant={tab === item.key ? "primary" : "secondary"} aria-current={tab === item.key ? "page" : undefined} onClick={() => { setTab(item.key); setOrder(null); setBatch(null); setFeedback(""); setError("") }}>{item.label}</AdminButton>)}
    </nav>
    {error && <div role="alert" className="rounded-xl border border-red-500/35 bg-red-950 p-3 text-sm text-white">{error}</div>}
    {loading && <p role="status" className="text-sm text-white/70">Cargando…</p>}

    {order ? <AdminSection compact className="dispatch-surface" title={orderCode(order.order.id)} eyebrow="Preparación" actions={<AdminButton size="sm" onClick={() => { setOrder(null); void refresh() }}>Volver</AdminButton>}>
      <p className="text-sm text-white/65">{order.itemCount} productos · {order.expectedUnits} unidades</p>
      {order.blocked && <p role="alert" className="mt-3 rounded-lg border border-amber-500/40 bg-amber-950 p-3 text-sm text-white">Este pedido requiere revisión antes del despacho.</p>}
      <div className="mt-3 space-y-2">{order.lines.map((line) => <AdminCard key={line.order_item_id} className="dispatch-card flex items-center justify-between gap-3 p-3"><span className="min-w-0 text-sm font-bold text-white">{line.name}<span className="block text-xs font-normal text-white/60">{line.expected_sku ?? line.expected_barcode}</span></span><AdminBadge tone={line.scanned_quantity === line.expected_quantity ? "success" : "neutral"}>{line.scanned_quantity} de {line.expected_quantity}</AdminBadge></AdminCard>)}</div>
      {!order.package ? <div className="mt-4"><AdminPrimaryButton disabled={busy || order.blocked} onClick={() => void run(async () => { setOrder(await dispatchRequest<OrderDetail>(`/orders/${order.order.id}`, { action: "start" })) })}>Iniciar preparación</AdminPrimaryButton></div> : completed ? <div className="mt-5 rounded-xl border border-emerald-500/35 bg-emerald-950 p-4"><p className="font-black text-white">✓ Pedido preparado</p><p className="mt-1 text-sm text-white/70">{orderCode(order.order.id)} · {order.expectedUnits} unidades verificadas</p><AdminPrimaryButton className="mt-3" onClick={() => { setOrder(null); setTab("ready"); void refresh() }}>Finalizar preparación</AdminPrimaryButton></div> : <form onSubmit={submitScan} className="mt-4 flex flex-col gap-2 sm:flex-row"><input ref={inputRef} aria-label="Escanear o ingresar SKU / código" autoFocus value={scan} onChange={(event) => { setScan(event.target.value); scanKey.current = null }} placeholder="Escanear o ingresar SKU / código" disabled={busy || order.blocked} className="admin-control-input admin-ds-control h-11 min-w-0 flex-1 px-4 text-sm text-white outline-none" /><AdminPrimaryButton type="submit" disabled={busy || !scan.trim() || order.blocked}>Verificar</AdminPrimaryButton></form>}
      {feedback && <p role="status" className="mt-2 text-sm text-emerald-300">{feedback}</p>}
      {order.package && !order.membership && <details className="mt-5 text-sm text-white/70"><summary className="cursor-pointer">Opciones</summary><AdminButton className="mt-2" size="sm" variant="ghost" onClick={() => { setReason(""); setDialog("reset") }}>Reiniciar preparación</AdminButton></details>}
      {order.batch && <Link href={`/admin/despachos?batch=${order.batch.id}`} className="mt-4 inline-block text-sm font-bold text-beyonix-cyan underline">Abrir tanda {order.batch.code}</Link>}
    </AdminSection> : batch ? <AdminSection compact className="dispatch-surface" title={batch.batch.code} eyebrow="Tanda de despacho" actions={<AdminButton size="sm" onClick={() => { setBatch(null); void refresh() }}>Volver</AdminButton>}>
      <div className="flex flex-wrap items-center gap-3"><AdminBadge tone={batch.batch.status === "handed_over" ? "success" : batch.blockedCount ? "warning" : "info"}>{batch.batch.status === "open" ? "Abierta" : batch.batch.status === "closed" ? "Cerrada" : "Entregada a Andreani"}</AdminBadge><span className="text-sm text-white/70">{batch.items.length} pedidos · {batch.items.length} bultos · {batch.blockedCount} bloqueados</span></div>
      {batch.batch.status === "handed_over" && <p role="status" className="mt-3 text-sm font-bold text-emerald-300">✓ Tanda entregada a Andreani · {dateTime(batch.batch.handed_over_at)}{batch.operatorName ? ` · ${batch.operatorName}` : ""}</p>}
      {batch.items.length > 0 && <div className="mt-4 space-y-2">{batch.items.map((item) => <AdminCard key={item.id} className="dispatch-card flex flex-wrap items-center justify-between gap-3 p-3"><div><Link href={`/admin/pedidos/${item.order_id}`} className="font-bold text-white underline">{orderCode(item.order_id)}</Link><span className="ml-3 text-xs text-white/60">1 bulto</span></div><div className="flex items-center gap-2"><AdminBadge tone={item.blocked ? "danger" : "success"}>{item.blocked ? "RETIRAR DEL DESPACHO" : "Listo"}</AdminBadge>{batch.batch.status !== "handed_over" && <AdminButton size="sm" variant="ghost" onClick={() => { setRemoveOrderId(item.order_id); setReason(""); setDialog("remove") }}>Retirar</AdminButton>}</div></AdminCard>)}</div>}
      {batch.batch.status === "open" && <div className="mt-5 space-y-4"><form onSubmit={submitOrderSearch} className="flex flex-col gap-2 sm:flex-row"><div className="flex-1"><AdminTextInput title="Agregar pedido" value={searchOrder} onChange={setSearchOrder} placeholder="Escanear o ingresar BX-1031" /></div><AdminPrimaryButton type="submit" disabled={busy || !searchOrder.trim()}>Agregar pedido</AdminPrimaryButton></form><AdminButton disabled={busy || batch.items.length === 0 || batch.blockedCount > 0} onClick={() => void run(async () => { setBatch(await dispatchRequest<BatchDetail>(`/batches/${batch.batch.id}`, { action: "close" })); setTab("closed") })}>Cerrar tanda</AdminButton>{batch.blockedCount > 0 && <p role="alert" className="text-sm text-amber-300">{orderCode(batch.items.find((item) => item.blocked)?.order_id ?? 0)} requiere revisión antes del despacho.</p>}</div>}
      {batch.batch.status !== "open" && <><DispatchLabel batch={batch.batch} orderCount={batch.items.length} barcodeUrl={barcodeUrl} /><div className="mt-4 flex flex-wrap gap-2"><AdminButton icon={<Printer className="size-4" />} disabled={!barcodeUrl} onClick={() => window.print()}>Imprimir etiqueta</AdminButton>{batch.batch.status === "closed" && <AdminPrimaryButton icon={<Truck className="size-4" />} disabled={busy || batch.blockedCount > 0} onClick={() => setDialog("handover")}>Confirmar entrega a Andreani</AdminPrimaryButton>}</div>{batch.blockedCount > 0 && batch.batch.status === "closed" && <p role="alert" className="mt-3 text-sm text-amber-300">{orderCode(batch.items.find((item) => item.blocked)?.order_id ?? 0)} requiere revisión antes del despacho.</p>}</>}
    </AdminSection> : <AdminSection compact className="dispatch-surface" title={TABS.find((item) => item.key === tab)?.label ?? "Despachos"} icon={<PackageCheck className="size-4" />} actions={tab === "open" ? <AdminPrimaryButton disabled={busy} onClick={() => { createKey.current ??= crypto.randomUUID(); void run(async () => { const detail = await dispatchRequest<BatchDetail>("/batches", { requestKey: createKey.current }); createKey.current = null; setBatch(detail) }) }}>Nueva tanda</AdminPrimaryButton> : undefined}>
      {(tab === "preparing" || tab === "ready") && <form onSubmit={submitOrderSearch} className="mb-4 flex flex-col gap-2 sm:flex-row"><div className="flex-1"><AdminTextInput title="Buscar pedido" value={searchOrder} onChange={setSearchOrder} placeholder="Buscar o escanear BX-1031" /></div><AdminButton type="submit" disabled={!searchOrder.trim()}>Abrir pedido</AdminButton></form>}
      {(tab === "preparing" || tab === "ready") ? <>{shownOrders.length ? <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{shownOrders.map((item) => <AdminCard key={item.id} interactive className="dispatch-card flex items-center justify-between gap-2"><div><p className="font-black text-white">{orderCode(item.id)}</p><p className="text-xs text-white/60">{item.package?.status === "prepared" ? "Listo para tanda" : item.package ? "Preparando" : "Pendiente"}</p></div><AdminButton size="sm" onClick={() => void openOrder(item.id)}>Abrir</AdminButton></AdminCard>)}</div> : <AdminEmptyState title="No hay pedidos en esta vista" description="Los pedidos aparecerán cuando estén disponibles para preparar o agregar a una tanda." />}</> : <>{shownBatches.length ? <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{shownBatches.map((item) => <AdminCard key={item.id} interactive className="dispatch-card flex items-center justify-between gap-2"><div><p className="font-black text-white">{item.code}</p><p className="text-xs text-white/60">{item.orderCount} pedidos · {item.packageCount} bultos · {item.blockedCount} bloqueados</p></div><AdminButton size="sm" onClick={() => void openBatch(item.id)}>Abrir</AdminButton></AdminCard>)}</div> : <AdminEmptyState title="No hay tandas en esta vista" description="Creá una nueva tanda con pedidos preparados." />}</>}
    </AdminSection>}

    <AdminModal open={dialog !== null} title={dialog === "reset" ? "Reiniciar preparación" : dialog === "remove" ? "Retirar pedido de la tanda" : "Confirmar entrega a Andreani"} description={dialog === "handover" ? `¿Confirmás que entregaste físicamente ${batch?.batch.code} a Andreani? ${batch?.items.length ?? 0} pedidos · ${batch?.items.length ?? 0} bultos.` : "Esta acción quedará registrada."} onClose={() => setDialog(null)} footer={<div className="flex justify-end gap-2"><AdminButton onClick={() => setDialog(null)}>Cancelar</AdminButton><AdminPrimaryButton disabled={busy || (dialog !== "handover" && reason.trim().length < 10)} onClick={() => void run(async () => {
      if (dialog === "reset" && order) { resetKey.current ??= crypto.randomUUID(); setOrder(await dispatchRequest<OrderDetail>(`/orders/${order.order.id}`, { action: "reset", reason, requestKey: resetKey.current })); resetKey.current = null }
      else if (dialog === "remove" && batch && removeOrderId) setBatch(await dispatchRequest<BatchDetail>(`/batches/${batch.batch.id}`, { action: "remove", orderId: removeOrderId, reason }))
      else if (dialog === "handover" && batch) { setBatch(await dispatchRequest<BatchDetail>(`/batches/${batch.batch.id}`, { action: "handover" })); setTab("handed_over") }
      setDialog(null); setReason("")
    })}>{dialog === "handover" ? "Confirmar entrega" : "Confirmar"}</AdminPrimaryButton></div>}>
      {dialog !== "handover" && <AdminTextInput title="Motivo obligatorio" value={reason} onChange={setReason} placeholder="Ingresá el motivo (mínimo 10 caracteres)" />}
      {dialog === "handover" && <p className="text-sm text-white/70">Este paso registra el momento en que la mercadería salió físicamente de BEYONIX.</p>}
    </AdminModal>
    <style>{`@media print { body * { visibility: hidden !important; } #dispatch-print-label, #dispatch-print-label * { visibility: visible !important; } #dispatch-print-label { position: fixed !important; left: 0 !important; top: 0 !important; width: 100mm !important; border: 0 !important; } }`}</style>
  </div>
}
