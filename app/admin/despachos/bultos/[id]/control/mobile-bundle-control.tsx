"use client"

import { useCallback, useEffect, useState } from "react"
import { MoreVertical } from "lucide-react"

import { CancellationResolution } from "@/app/admin/sections/despachos/cancellation-resolution"
import { dispatchRequest } from "@/app/admin/sections/despachos/dispatch-request"
import { orderCode, type DispatchBatch, type DispatchHold } from "@/lib/admin/dispatch"

type ControlItem = { orderId: number; status: "CORRECTO" | "CANCELADO"; blocked: boolean; hold: DispatchHold | null }
type ControlDetail = { batch: DispatchBatch; name: number; items: ControlItem[]; removedOrderIds: number[]; parcelCount: number }

const date = (value: string) => new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(value))

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
    if (!detail || busy || detail.batch.status === "handed_over" || !detail.items.length || detail.items.some((item) => item.blocked || item.status === "CANCELADO")) return
    setBusy(true); setError("")
    try { await dispatchRequest(`/batches/${id}/control`, {}); await reload() }
    catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo confirmar el Bulto."); await reload() }
    finally { setBusy(false) }
  }

  if (loading) return <main className="mx-auto max-w-2xl px-4 py-8 text-sm">Cargando Bulto…</main>
  if (!detail) return <main className="mx-auto max-w-2xl px-4 py-8" role="alert">{error || "Bulto no encontrado."}</main>
  return <MobileBundleView detail={detail} busy={busy} error={error} resolving={resolving}
    onResolve={setResolving} onRefresh={() => void reload()} onConfirm={() => void confirm()} />
}

export function MobileBundleView({ detail, busy, error, resolving, onResolve, onRefresh, onConfirm }: {
  detail: ControlDetail; busy: boolean; error: string; resolving: DispatchHold | null
  onResolve: (hold: DispatchHold | null) => void; onRefresh: () => void; onConfirm: () => void
}) {
  const delivered = detail.batch.status === "handed_over"
  const blocked = detail.items.some((item) => item.blocked || item.status === "CANCELADO")
  return <main className="mx-auto w-full max-w-2xl px-3 pb-8 pt-5 text-[color:var(--beyonix-text-primary)] sm:px-6 sm:pt-8">
    <header className="border-b border-white/15 pb-4">
      <h1 className="text-xl font-bold">Bulto: {String(detail.name).padStart(4, "0")}</h1>
      <p className="mt-1 text-sm text-[color:var(--beyonix-text-secondary)]">Fecha: {date(detail.batch.created_at)}</p>
      {delivered && <p className="mt-2 font-bold text-emerald-300" role="status">ENTREGADO ✓</p>}
    </header>

    {resolving ? <section className="mt-5" aria-label="Retirar pedido cancelado">
      <CancellationResolution hold={resolving} onResolved={onRefresh} onClose={() => { onResolve(null); onRefresh() }} />
    </section> : <>
      <table className="mt-4 w-full table-fixed border-collapse text-sm" aria-label="Pedidos del Bulto">
        <thead><tr className="border-b border-white/20 text-left text-xs uppercase tracking-wide text-white/60"><th className="w-[46%] pb-3 font-semibold">Número de pedido</th><th className="pb-3 font-semibold">Estado</th><th className="w-10 pb-3"><span className="sr-only">Acciones</span></th></tr></thead>
        <tbody>{detail.items.map((item) => <tr key={item.orderId} className="border-b border-white/10">
          <td className="py-3 font-semibold tabular-nums text-[color:var(--beyonix-text-primary)]">{orderCode(item.orderId)}</td>
          <td className={`py-3 font-semibold ${item.status === "CANCELADO" ? "text-red-300" : "text-emerald-300"}`}>{item.status} {item.status === "CANCELADO" ? "❌" : "✅"}</td>
          <td className="py-2 text-right">{item.status === "CANCELADO" && item.hold && !delivered && <details className="relative"><summary aria-label={`Opciones de ${orderCode(item.orderId)}`} className="flex size-9 cursor-pointer list-none items-center justify-center rounded-md hover:bg-white/10"><MoreVertical className="size-5" /></summary><button type="button" className="absolute right-0 z-10 rounded-md border border-white/20 bg-[#142536] px-4 py-2 font-semibold shadow-lg" onClick={() => onResolve(item.hold)}>Retirar</button></details>}</td>
        </tr>)}{detail.removedOrderIds.map((orderId) => <tr key={`removed-${orderId}`} className="border-b border-white/10 text-[color:var(--beyonix-text-secondary)]"><td className="py-3 tabular-nums">{orderCode(orderId)}</td><td className="py-3">RETIRADO</td><td /></tr>)}</tbody>
      </table>
      <p className="mt-6 text-base font-semibold">Cantidad de paquetes a despachar: <span className="tabular-nums">{detail.parcelCount}</span></p>
      {!delivered && <button type="button" className="mt-5 h-12 w-full rounded-lg bg-[#1c9bcc] px-4 font-bold text-white disabled:cursor-not-allowed disabled:opacity-40" disabled={busy || blocked || Boolean(error) || detail.items.length === 0} onClick={onConfirm}>{busy ? "Confirmando…" : "CONFIRMAR"}</button>}
      {blocked && !delivered && <p className="mt-2 text-sm text-amber-200">{detail.items.some((item) => item.status === "CANCELADO")
        ? "Retirá los pedidos cancelados antes de confirmar."
        : "Hay un pedido que requiere revisión desde Despachos."}</p>}
      {error && <p role="alert" className="mt-3 text-sm text-red-300">{error}</p>}
    </>}
  </main>
}
