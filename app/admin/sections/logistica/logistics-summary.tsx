"use client"

import { useCallback, useEffect, useState } from "react"

import { AdminHelpTip } from "@/app/admin/components/admin-help-tip"
import { AdminDatePicker } from "@/app/admin/components/admin-date-picker"
import type { LogisticsOrderRow, LogisticsSummary } from "@/lib/admin/logistics"
import { supabase } from "@/lib/supabase/client"

export interface LogisticsResponse {
  range: { from: string; to: string }
  summary: LogisticsSummary
  orders: { rows: LogisticsOrderRow[]; total: number; pageSize: number } | null
  error?: string
}

export const formatMoney = (value: number) =>
  new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 }).format(value)
export const formatSignedMoney = (value: number) => `${value > 0 ? "+" : value < 0 ? "−" : ""}${formatMoney(Math.abs(value))}`
export const formatSignedPercent = (value: number) =>
  `${value > 0 ? "+" : value < 0 ? "−" : ""}${new Intl.NumberFormat("es-AR", { maximumFractionDigits: 1 }).format(Math.abs(value))}%`

export const BILLING_PENDING_LABEL = "Pendiente / No conciliado"

/** Explicaciones cortas de cada métrica (tooltip "(?)"). */
export const LOGISTICS_HELP = {
  ordersCreated: "Pedidos del período con envío generado en Andreani.",
  ordersSent: "Pedidos entregados a Andreani o ya en camino.",
  ordersDelivered: "Pedidos que Andreani informó como entregados.",
  ordersReturned: "Pedidos con devolución, cambio o reclamo.",
  parcels: "Bultos reales definidos al finalizar el armado.",
  charged: "Importe de envío que efectivamente pagó el cliente.",
  providerQuoted: "Tarifa informada por Andreani al cotizar el envío.",
  markupPercent: "Porcentaje BEYONIX vigente cuando se creó el pedido.",
  markup: "Importe adicional generado por el recargo logístico.",
  benefit: "Parte del envío cubierta por BEYONIX.",
  parcelQuoted: "Tarifa calculada usando las medidas reales del pedido armado.",
  difference: "Cotizado con bulto real menos tarifa de checkout, en pedidos con ambos datos.",
  billed: "Importe realmente facturado por Andreani después de conciliación.",
  reconciliation: "Conciliado sólo con factura o liquidación real de Andreani.",
} as const

async function authHeaders(): Promise<HeadersInit | null> {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  return token ? { Authorization: `Bearer ${token}` } : null
}

/** Carga resumen (y opcionalmente pedidos) del período. `forbidden` = no es Admin. */
export function useLogistics(from: string, to: string, options: { orders?: boolean; page?: number } = {}) {
  const [data, setData] = useState<LogisticsResponse | null>(null)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(true)
  const [forbidden, setForbidden] = useState(false)
  const { orders = false, page = 1 } = options

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    try {
      const headers = await authHeaders()
      if (!headers) { setError("No se pudo validar la sesión."); return }
      const query = new URLSearchParams({ from, to, page: String(page), ...(orders ? { orders: "1" } : {}) })
      const response = await fetch(`/api/admin/logistics?${query}`, { headers, signal })
      if (response.status === 401 || response.status === 403) { setForbidden(true); return }
      const body = (await response.json()) as LogisticsResponse
      if (!response.ok) { setError(body.error ?? "No se pudo cargar la logística."); return }
      setData(body)
      setError("")
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === "AbortError")) setError("No se pudo cargar la logística.")
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [from, to, orders, page])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  return { data, error, loading, forbidden }
}

/** Primer día del mes y hoy, en hora Argentina (mismo default que el servidor). */
export function currentMonthRange(now = new Date()) {
  const today = new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10)
  return { from: `${today.slice(0, 8)}01`, to: today }
}

function Metric({ label, help, value, detail, tone }: {
  label: string
  help: string
  value: string
  detail?: string
  tone?: "warning" | "positive"
}) {
  return (
    <div className="admin-logistics-metric min-w-0 rounded-xl border border-beyonix-blue-light/14 bg-[rgba(3,7,13,0.72)] px-3 py-2.5" data-logistics-metric={label}>
      <p className="flex items-center gap-1 text-10px font-black uppercase tracking-widest text-white/50">
        {label}
        <AdminHelpTip label={label} text={help} />
      </p>
      <p className={`mt-1 truncate text-base font-black tabular-nums ${tone === "warning" ? "text-amber-200" : tone === "positive" ? "text-emerald-300" : "text-white"}`}>{value}</p>
      {detail ? <p className="mt-1 truncate text-11px font-semibold text-white/45">{detail}</p> : null}
    </div>
  )
}

export function LogisticsSummaryGrid({ summary, hideAmounts = false }: { summary: LogisticsSummary; hideAmounts?: boolean }) {
  const money = (value: number) => hideAmounts ? "••••••" : formatMoney(value)
  const differencePercent = summary.comparableProviderQuoted > 0
    ? (summary.parcelQuoteDifference / summary.comparableProviderQuoted) * 100
    : null
  const legacyOrders = summary.soldOrders - summary.snapshotOrders
  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-3 xl:grid-cols-5">
        <Metric label="Pedidos Andreani creados" help={LOGISTICS_HELP.ordersCreated} value={String(summary.ordersCreated)} />
        <Metric label="Pedidos enviados" help={LOGISTICS_HELP.ordersSent} value={String(summary.ordersSent)} />
        <Metric label="Entregados" help={LOGISTICS_HELP.ordersDelivered} value={String(summary.ordersDelivered)} />
        <Metric label="Devoluciones / cambios" help={LOGISTICS_HELP.ordersReturned} value={String(summary.ordersReturned)} />
        <Metric label="Bultos totales" help={LOGISTICS_HELP.parcels} value={String(summary.parcels)} />
      </div>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Cobrado al cliente por envíos" help={LOGISTICS_HELP.charged} value={money(summary.chargedToCustomers)} detail={`${summary.soldOrders} pedidos vendidos`} />
        <Metric label="Tarifa Andreani checkout" help={LOGISTICS_HELP.providerQuoted} value={money(summary.providerQuoted)} detail={legacyOrders > 0 ? `${legacyOrders} pedidos anteriores sin desglose` : "Con el bulto estimado"} />
        <Metric label="Costo extra cobrado" help={LOGISTICS_HELP.markup} value={money(summary.markupCollected)} detail="Suma de cada recargo aplicado" tone="positive" />
        <Metric label="Beneficio cubierto por BEYONIX" help={LOGISTICS_HELP.benefit} value={money(summary.benefitAbsorbed)} detail="Bonificaciones de envío" />
        <Metric label="Cotizado con bultos reales" help={LOGISTICS_HELP.parcelQuoted} value={money(summary.parcelQuoted)} detail={`${summary.parcelQuotedOrders} pedidos recotizados`} />
        <Metric
          label="Diferencia checkout vs armado"
          help={LOGISTICS_HELP.difference}
          value={hideAmounts ? "••••••" : formatSignedMoney(summary.parcelQuoteDifference)}
          detail={differencePercent === null ? "Sin pedidos comparables" : `${formatSignedPercent(differencePercent)} · ${summary.parcelQuoteComparableOrders} pedidos`}
          tone={differencePercent !== null && Math.abs(differencePercent) >= 10 ? "warning" : undefined}
        />
        <Metric
          label="Facturado Andreani"
          help={LOGISTICS_HELP.billed}
          value={summary.billedOrders > 0 ? money(summary.billedByAndreani) : BILLING_PENDING_LABEL}
          detail={summary.billedOrders > 0 ? `${summary.billedOrders} pedidos conciliados` : "Sin fuente de facturación conectada"}
        />
      </div>
    </div>
  )
}

export function LogisticsRangeFilter({ from, to, onChange }: {
  from: string
  to: string
  onChange: (range: { from: string; to: string }) => void
}) {
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="w-[150px]">
        <span className="mb-1.5 block text-center text-10px font-black uppercase tracking-widest text-white/42">Desde</span>
        <AdminDatePicker title="Desde" ariaLabel="Logística desde" value={from} placeholder="Desde" compact onChange={(value) => value && onChange({ from: value, to })} onSelectMonth={onChange} onSelectYear={onChange} />
      </div>
      <div className="w-[150px]">
        <span className="mb-1.5 block text-center text-10px font-black uppercase tracking-widest text-white/42">Hasta</span>
        <AdminDatePicker title="Hasta" ariaLabel="Logística hasta" value={to} placeholder="Hasta" compact onChange={(value) => value && onChange({ from, to: value })} onSelectMonth={onChange} onSelectYear={onChange} />
      </div>
    </div>
  )
}
