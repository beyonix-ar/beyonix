"use client"

import { useCallback, useEffect, useState } from "react"

import { CancellationResolution } from "@/app/admin/sections/despachos/cancellation-resolution"
import { dispatchRequest } from "@/app/admin/sections/despachos/dispatch-request"
import { DISPATCH_HANDOVER_BLOCKED_MESSAGE, orderCode, type DispatchBatch, type DispatchHold } from "@/lib/admin/dispatch"

type ControlItem = { orderId: number; status: "CORRECTO" | "CANCELADO"; blocked: boolean; reason?: string | null; hold: DispatchHold | null }
type ControlDetail = { batch: DispatchBatch; name: number; items: ControlItem[]; removedOrderIds: number[]; parcelCount: number }

const date = (value: string) => new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(value))
const needsAttention = (item: ControlItem) => item.blocked || item.status === "CANCELADO"
const plural = (count: number) => `${count} ${count === 1 ? "pedido requiere" : "pedidos requieren"} atención`

export function MobileBundleControl({ id }: { id: string }) {
  const [detail, setDetail] = useState<ControlDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [resolving, setResolving] = useState<DispatchHold | null>(null)

  const reload = useCallback(async () => {
    try { setDetail(await dispatchRequest<ControlDetail>(`/batches/${id}/control`)); setError("") }
    catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo cargar el Bulto.") }
    finally { setLoading(false) }
  }, [id])

  useEffect(() => { void reload() }, [reload])
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === "visible") void reload() }
    document.addEventListener("visibilitychange", onVisible)
    return () => document.removeEventListener("visibilitychange", onVisible)
  }, [reload])

  async function confirm() {
    if (!detail || busy || detail.batch.status === "handed_over" || !detail.items.length || detail.items.some(needsAttention)) return
    setBusy(true); setError("")
    // La base vuelve a validar TODOS los pedidos con las filas bloqueadas: si
    // alguien canceló mientras tanto, nada se entrega y la lista se recarga.
    try { await dispatchRequest(`/batches/${id}/control`, {}); await reload() }
    catch (cause) { await reload(); setError(cause instanceof Error ? cause.message : "No se pudo confirmar el Bulto.") }
    finally { setBusy(false) }
  }

  /** Pedido con una incidencia (no cancelado): sale del Bulto con el motivo auditado. */
  async function remove(item: ControlItem) {
    if (busy) return
    setBusy(true); setError("")
    try {
      await dispatchRequest(`/batches/${id}`, { action: "remove", orderId: item.orderId, reason: `Retirado en el control final del Bulto: ${item.reason ?? "requiere revisión"}` })
      await reload()
    } catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo retirar el pedido.") }
    finally { setBusy(false) }
  }

  if (loading) return <main className="mx-auto max-w-2xl px-4 py-8 text-sm">Cargando Bulto…</main>
  if (!detail) return <main className="mx-auto max-w-2xl px-4 py-8" role="alert">{error || "Bulto no encontrado."}</main>
  return <MobileBundleView detail={detail} busy={busy} error={error} resolving={resolving}
    onResolve={setResolving} onRemove={(item) => void remove(item)} onRefresh={() => void reload()} onConfirm={() => void confirm()} />
}

export function MobileBundleView({ detail, busy, error, resolving, onResolve, onRemove, onRefresh, onConfirm }: {
  detail: ControlDetail; busy: boolean; error: string; resolving: DispatchHold | null
  onResolve: (hold: DispatchHold | null) => void; onRemove?: (item: ControlItem) => void; onRefresh: () => void; onConfirm: () => void
}) {
  const delivered = detail.batch.status === "handed_over"
  const attention = detail.items.filter(needsAttention)
  const blocked = attention.length > 0
  return <main className="mx-auto w-full max-w-2xl px-3 pb-8 pt-5 text-[color:var(--beyonix-text-primary)] sm:px-6 sm:pt-8">
    <header className="border-b border-white/15 pb-4">
      <h1 className="text-xl font-bold">Bulto: {String(detail.name).padStart(4, "0")}</h1>
      <p className="mt-1 text-sm text-[color:var(--beyonix-text-secondary)]">Fecha: {date(detail.batch.created_at)}</p>
      {delivered && <p className="mt-2 font-bold text-emerald-300" role="status">DESPACHADO ✓</p>}
    </header>

    {blocked && !delivered && !resolving && <section role="alert" className="mt-4 rounded-lg border border-red-400/50 bg-red-950/70 px-3 py-3">
      <p className="font-bold text-white">{DISPATCH_HANDOVER_BLOCKED_MESSAGE}</p>
      <p className="mt-1 text-sm font-semibold text-red-200">⚠ {plural(attention.length)}</p>
    </section>}

    {resolving ? <section className="mt-5" aria-label="Retirar pedido cancelado">
      <CancellationResolution hold={resolving} onResolved={onRefresh} onClose={() => { onResolve(null); onRefresh() }} />
    </section> : <>
      <table className="mt-4 w-full table-fixed border-collapse text-sm" aria-label="Pedidos del Bulto">
        <thead><tr className="border-b border-white/20 text-left text-xs uppercase tracking-wide text-white/60"><th className="w-[40%] pb-3 font-semibold">Número de pedido</th><th className="pb-3 font-semibold">Estado</th><th className="w-[38%] pb-3"><span className="sr-only">Acciones</span></th></tr></thead>
        <tbody>{detail.items.map((item) => {
          const problem = needsAttention(item)
          const label = item.status === "CANCELADO" ? "CANCELADO" : problem ? "INCIDENCIA" : "CORRECTO"
          return <tr key={item.orderId} className="border-b border-white/10">
            <td className="py-3 font-semibold tabular-nums text-[color:var(--beyonix-text-primary)]">{orderCode(item.orderId)}</td>
            <td className={`py-3 font-semibold ${problem ? "text-red-300" : "text-emerald-300"}`}>{label} {problem ? "❌" : "✅"}
              {problem && item.status !== "CANCELADO" && item.reason && <span className="block text-xs font-medium text-red-200">{item.reason}</span>}</td>
            <td className="py-2 text-right">{problem && !delivered && (item.hold || onRemove) && <button type="button" disabled={busy}
              className="min-h-10 rounded-md border border-red-300/40 bg-red-500/15 px-3 text-xs font-bold text-white disabled:opacity-50"
              onClick={() => { if (item.hold) onResolve(item.hold); else onRemove?.(item) }}>Retirar del Bulto</button>}</td>
          </tr>
        })}{detail.removedOrderIds.map((orderId) => <tr key={`removed-${orderId}`} className="border-b border-white/10 text-[color:var(--beyonix-text-secondary)]"><td className="py-3 tabular-nums">{orderCode(orderId)}</td><td className="py-3">RETIRADO</td><td /></tr>)}</tbody>
      </table>
      <p className="mt-6 text-base font-semibold">Cantidad de paquetes a despachar: <span className="tabular-nums">{detail.parcelCount}</span></p>
      {!delivered && !blocked && detail.items.length > 0 && <p role="status" className="mt-3 font-bold text-emerald-300">✓ Bulto listo para entregar</p>}
      {!delivered && <button type="button" className="mt-5 h-12 w-full rounded-lg bg-[#1c9bcc] px-4 font-bold text-white disabled:cursor-not-allowed disabled:opacity-40" disabled={busy || blocked || detail.items.length === 0} onClick={onConfirm}>{busy ? "Confirmando…" : "CONFIRMAR"}</button>}
      {error && <p role="alert" className="mt-3 text-sm text-red-300">{error}</p>}
    </>}
  </main>
}
