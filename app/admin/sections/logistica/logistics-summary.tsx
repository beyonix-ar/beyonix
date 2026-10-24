"use client"

import { useCallback, useEffect, useState } from "react"
import { Boxes, CircleDollarSign, ClipboardCheck } from "lucide-react"

import { AdminHelpTip } from "@/app/admin/components/admin-help-tip"
import { AdminDatePicker } from "@/app/admin/components/admin-date-picker"
import { AdminBadge, AdminSection } from "@/app/admin/components/admin-controls"
import { BILLED_HELP } from "@/lib/admin/andreani-billing"
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
  parcels: "Paquetes de envío medidos definidos al finalizar el armado.",
  charged: "Importe de envío que efectivamente pagó el cliente.",
  providerQuoted: "Tarifa informada por Andreani al cotizar el envío.",
  markupPercent: "Porcentaje BEYONIX vigente cuando se creó el pedido.",
  markup: "Importe efectivamente cobrado al cliente por encima de la tarifa cotizada por Andreani. No incluye recargos bonificados.",
  benefit: "Parte del envío cubierta por BEYONIX.",
  parcelQuoted: "Tarifa calculada usando las medidas reales del pedido armado.",
  difference: "Cotizado con paquetes de envío medidos menos tarifa de checkout, en pedidos con ambos datos.",
  billed: BILLED_HELP,
  billedVsCheckout: "Facturado por el envío original menos la tarifa cotizada en checkout (snapshot al conciliar).",
  billedVsParcel: "Facturado por el envío original menos la tarifa recotizada con los paquetes de envío medidos (snapshot al conciliar).",
  reconciliation: "Compara lo facturado por el envío original con la cotización con paquetes de envío medidos (o la de checkout si no hay).",
  reconciledOrders: "Pedidos cuyo facturado coincide con lo cotizado dentro del margen de redondeo.",
  pendingReconciliation: "Pedidos vendidos sin facturación de Andreani registrada.",
  majorDifference: "Pedidos con diferencia importante entre facturado y cotizado.",
} as const

async function authHeaders(): Promise<HeadersInit | null> {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  return token ? { Authorization: `Bearer ${token}` } : null
}

/** Carga resumen (y opcionalmente pedidos) del período. `forbidden` = no es Admin. */
export function useLogistics(from: string, to: string, options: { orders?: boolean; page?: number; version?: number } = {}) {
  const [data, setData] = useState<LogisticsResponse | null>(null)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(true)
  const [forbidden, setForbidden] = useState(false)
  const { orders = false, page = 1, version = 0 } = options

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

  // version: recarga explícita después de conciliar o importar.
  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load, version])

  return { data, error, loading, forbidden }
}

/** Primer día del mes y hoy, en hora Argentina (mismo default que el servidor). */
export function currentMonthRange(now = new Date()) {
  const today = new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10)
  return { from: `${today.slice(0, 8)}01`, to: today }
}

function Metric({ label, help, value, detail, tone, page = false, primary = false, badge }: {
  label: string
  help: string
  value: string
  detail?: string
  tone?: "warning" | "positive" | "danger"
  page?: boolean
  primary?: boolean
  badge?: string
}) {
  const valueTone = tone === "danger" ? "text-red-300" : tone === "warning" ? "text-amber-200" : tone === "positive" ? "text-emerald-300" : "text-white"
  return (
    <div className={`admin-logistics-metric min-w-0 rounded-xl border border-beyonix-blue-light/14 bg-[rgba(3,7,13,0.72)] ${page ? "flex min-h-28 flex-col justify-between gap-3 p-4 sm:p-5" : "px-3 py-2.5"}`} data-logistics-metric={label}>
      <div className="flex min-w-0 items-start justify-between gap-2">
        <p className={`flex min-w-0 items-start gap-1 font-black uppercase tracking-wider text-white/60 ${page ? "text-11px leading-4" : "text-10px"}`}>
          <span>{label}</span>
          <AdminHelpTip label={label} text={help} />
        </p>
        {page && badge ? <AdminBadge tone={tone === "danger" ? "danger" : tone === "warning" ? "warning" : tone === "positive" ? "success" : "neutral"} className="shrink-0">{badge}</AdminBadge> : null}
      </div>
      <div>
        <p className={`font-black tabular-nums ${valueTone} ${page ? primary ? "text-3xl leading-none" : "break-words text-xl leading-tight" : "mt-1 truncate text-base"}`}>{value}</p>
        {detail ? <p className={`${page ? "mt-2 text-xs leading-5 text-white/55" : "mt-1 truncate text-11px font-semibold text-white/45"}`}>{detail}</p> : null}
      </div>
    </div>
  )
}

export function LogisticsSummaryGrid({ summary, hideAmounts = false, page = false }: { summary: LogisticsSummary; hideAmounts?: boolean; page?: boolean }) {
  const money = (value: number) => hideAmounts ? "••••••" : formatMoney(value)
  const differencePercent = summary.comparableProviderQuoted > 0
    ? (summary.parcelQuoteDifference / summary.comparableProviderQuoted) * 100
    : null
  const legacyOrders = summary.soldOrders - summary.snapshotOrders
  const operational = [
    <Metric key="created" page={page} primary={page} label="Pedidos Andreani creados" help={LOGISTICS_HELP.ordersCreated} value={String(summary.ordersCreated)} />,
    <Metric key="sent" page={page} primary={page} label="Pedidos enviados" help={LOGISTICS_HELP.ordersSent} value={String(summary.ordersSent)} />,
    <Metric key="delivered" page={page} primary={page} label="Entregados" help={LOGISTICS_HELP.ordersDelivered} value={String(summary.ordersDelivered)} />,
    <Metric key="returned" page={page} primary={page} label="Devoluciones / cambios" help={LOGISTICS_HELP.ordersReturned} value={String(summary.ordersReturned)} />,
    <Metric key="parcels" page={page} primary={page} label="Paquetes de envío totales" help={LOGISTICS_HELP.parcels} value={String(summary.parcels)} />,
  ]
  const economics = [
    <Metric key="charged" page={page} label="Cobrado al cliente por envíos" help={LOGISTICS_HELP.charged} value={money(summary.chargedToCustomers)} detail={`${summary.soldOrders} pedidos vendidos`} />,
    <Metric key="quoted" page={page} label="Tarifa Andreani checkout" help={LOGISTICS_HELP.providerQuoted} value={money(summary.providerQuoted)} detail={legacyOrders > 0 ? `${legacyOrders} pedidos anteriores sin desglose` : "Con el paquete estimado"} />,
    <Metric key="markup" page={page} label="Costo extra cobrado" help={LOGISTICS_HELP.markup} value={money(summary.markupCollected)} detail="Excedente realmente pagado sobre la tarifa Andreani" tone="positive" />,
    <Metric key="benefit" page={page} label="Beneficio cubierto por BEYONIX" help={LOGISTICS_HELP.benefit} value={money(summary.benefitAbsorbed)} detail="Bonificaciones de envío" />,
    <Metric key="parcel" page={page} label="Cotizado con paquetes de envío medidos" help={LOGISTICS_HELP.parcelQuoted} value={money(summary.parcelQuoted)} detail={`${summary.parcelQuotedOrders} pedidos recotizados`} />,
    <Metric key="billed" page={page} label="Facturado Andreani" help={LOGISTICS_HELP.billed} value={summary.billedOrders > 0 ? money(summary.billedByAndreani) : BILLING_PENDING_LABEL}
      detail={summary.billedOrders > 0 ? `${summary.billedOrders} pedidos · devoluciones y cambios ${money(summary.billedReturnsAndExchanges)}` : "Sin facturación cargada en el período"}
      badge={summary.billedOrders > 0 ? "Con registros" : "Sin facturación"} />,
  ]
  const differences = [
    <Metric key="checkout-parcel" page={page} label="Diferencia checkout vs armado" help={LOGISTICS_HELP.difference}
      value={hideAmounts ? "••••••" : formatSignedMoney(summary.parcelQuoteDifference)}
      detail={differencePercent === null ? "Sin pedidos comparables" : `${formatSignedPercent(differencePercent)} · ${summary.parcelQuoteComparableOrders} pedidos`}
      tone={differencePercent !== null && Math.abs(differencePercent) >= 10 ? "warning" : undefined} />,
    <Metric key="billed-checkout" page={page} label="Diferencia vs checkout" help={LOGISTICS_HELP.billedVsCheckout}
      value={summary.billedDifferenceVsCheckoutOrders ? (hideAmounts ? "••••••" : formatSignedMoney(summary.billedDifferenceVsCheckout)) : "—"}
      detail={`${summary.billedDifferenceVsCheckoutOrders} pedidos comparables`} />,
    <Metric key="billed-parcel" page={page} label="Diferencia vs paquetes de envío medidos" help={LOGISTICS_HELP.billedVsParcel}
      value={summary.billedDifferenceVsParcelOrders ? (hideAmounts ? "••••••" : formatSignedMoney(summary.billedDifferenceVsParcel)) : "—"}
      detail={`${summary.billedDifferenceVsParcelOrders} pedidos comparables`} />,
  ]
  const reconciliation = [
    <Metric key="reconciled" page={page} label="Pedidos conciliados" help={LOGISTICS_HELP.reconciledOrders} value={String(summary.reconciledOrders)} detail={`${summary.minorDifferenceOrders} con diferencia menor`} tone={summary.reconciledOrders ? "positive" : undefined} badge="Controlados" />,
    <Metric key="pending" page={page} label="Pendientes de conciliar" help={LOGISTICS_HELP.pendingReconciliation} value={String(summary.pendingReconciliationOrders)} detail={summary.noReferenceOrders ? `${summary.noReferenceOrders} sin cotización de referencia` : undefined} tone={summary.pendingReconciliationOrders ? "warning" : page ? "positive" : undefined} badge={summary.pendingReconciliationOrders ? "Revisar" : "Al día"} />,
    <Metric key="major" page={page} label="Diferencia importante"
      help={`${LOGISTICS_HELP.majorDifference} Umbral: desde ${formatMoney(summary.thresholds.majorAmount)} o ${summary.thresholds.majorPercent}%; conciliado si la diferencia es menor a ${formatMoney(summary.thresholds.reconciledAmount)}.`}
      value={String(summary.majorDifferenceOrders)} detail={summary.unmatchedEntries ? `${summary.unmatchedEntries} cargos sin pedido asociado` : undefined}
      tone={summary.majorDifferenceOrders ? "danger" : page ? "positive" : undefined} badge={summary.majorDifferenceOrders ? "Atención" : "Sin alertas"} />,
  ]

  if (!page) {
    return (
      <div className="space-y-3">
        <div className="grid gap-2 sm:grid-cols-3 xl:grid-cols-5">{operational}</div>
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">{economics}{differences[0]}</div>
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">{differences.slice(1)}{reconciliation}</div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <AdminSection icon={<Boxes className="size-5" />} eyebrow="01 · Operación" title="Resumen operativo" description="Volumen de pedidos, entregas y bultos del período." data-logistics-section="operational">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">{operational}</div>
      </AdminSection>
      <AdminSection icon={<CircleDollarSign className="size-5" />} eyebrow="02 · Importes" title="Costos y cobros" description="Importes cobrados al cliente, cotizaciones y facturación de Andreani." data-logistics-section="economics">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{economics}</div>
      </AdminSection>
      <AdminSection icon={<ClipboardCheck className="size-5" />} eyebrow="03 · Control" title="Conciliación y diferencias" description="Compará cotizaciones con importes facturados e identificá lo que requiere revisión." data-logistics-section="reconciliation">
        <p className="mb-3 text-11px font-black uppercase tracking-widest text-white/45">Comparaciones de importes</p>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{differences}</div>
        <p className="mb-3 mt-6 text-11px font-black uppercase tracking-widest text-white/45">Estado de los pedidos</p>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{reconciliation}</div>
      </AdminSection>
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
