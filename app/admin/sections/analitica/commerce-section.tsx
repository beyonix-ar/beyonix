"use client"

import type { ReactNode } from "react"

import {
  ABANDONMENT_WINDOW_HOURS,
  abandonedTotal,
  abandonmentRate,
  cartConversion,
  formatRate,
  formatRevenue,
  funnelStages,
  purchaseConversion,
  type CommercePeriod,
  type CommerceReport,
} from "@/lib/analytics/commerce-report"
import { compareMetric, compareRate, type MetricChange } from "@/lib/analytics/period-comparison"
import type { AnalyticsDateRange } from "@/lib/analytics/product-view-report"

import { AdminHelpTip } from "../../components/admin-help-tip"
import { AdminSkeleton } from "../../components/admin-controls"
import { ChangeLine } from "./period-change"
import { AnalyticsStatCard } from "./stat-card"
import { useAnalyticsReport, type AnalyticsReportState } from "./use-analytics-report"

const countFormatter = new Intl.NumberFormat("es-AR")
const sessionsLabel = (count: number) => `${countFormatter.format(count)} ${count === 1 ? "sesión" : "sesiones"}`

const CART_CONVERSION_HELP =
  "Sesiones que vieron productos y agregaron al carrito (o llegaron al checkout con un carrito armado antes), sobre las sesiones con visualizaciones. La variación es en puntos porcentuales."
const PURCHASE_CONVERSION_HELP =
  "Sesiones que vieron productos y crearon un pedido con pago confirmado, sobre las sesiones con visualizaciones. La variación es en puntos porcentuales."
const PURCHASES_HELP =
  "Pedidos con pago confirmado en el período (Mercado Pago, transferencia, confirmación manual o saldo a favor). No incluye pendientes, rechazados ni cancelados sin pago. Atribuibles: los que se pueden vincular a una sesión de la tienda; sólo esos entran al funnel. Es una lectura comercial: los montos oficiales están en el Dashboard."
const ABANDONMENT_HELP = `Sesiones con carrito que no terminaron en compra, evaluadas ${ABANDONMENT_WINDOW_HOURS} h después de su última actividad de carrito o checkout (antes se consideran en curso). Tasa: abandonados sobre carritos evaluados. Subir es negativo.`
const FUNNEL_HELP =
  "Sesiones únicas, no eventos. Parte de las sesiones con visualizaciones y cada etapa cuenta las que llegaron a ella o a una posterior (comprar implica checkout y carrito), así la progresión nunca sube. La compra cuenta aunque el pago se confirme después."

export function useCommerceReport(range: AnalyticsDateRange | null, rangeKey: string | null) {
  return useAnalyticsReport<CommerceReport>("/api/admin/analytics/commerce", "No se pudo cargar la conversión.", range, rangeKey)
}

/** Variación de una métrica comercial entre ambos períodos (`null` si falta alguno). */
function change(report: CommerceReport | null, compare: (current: CommercePeriod, previous: CommercePeriod) => MetricChange | null) {
  return report?.current && report.previous ? compare(report.current, report.previous) : null
}

/**
 * Cards principales de conversión. Mientras carga un período nuevo no muestra
 * datos del anterior; un refresh fallido conserva el último dato válido.
 */
export function CommerceCards({ report, loadError }: AnalyticsReportState<CommerceReport>) {
  const current = report?.current ?? null
  const previousRange = report?.previousRange
  const line = (value: MetricChange | null, higherIsBetter = true) =>
    previousRange ? <ChangeLine change={value} previousRange={previousRange} higherIsBetter={higherIsBetter} /> : null

  return (
    <div className="admin-analytics-commerce-cards grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
      <AnalyticsStatCard
        className="admin-analytics-cart-conversion"
        label="Conversión a carrito"
        help={CART_CONVERSION_HELP}
        value={current ? formatRate(cartConversion(current)) : null}
        detail={current ? `${sessionsLabel(current.funnelCart)} de ${countFormatter.format(current.viewedSessions)} con visualizaciones` : ""}
        loadError={loadError}
        change={line(change(report, (now, before) => compareRate(cartConversion(now), cartConversion(before))))}
      />
      <AnalyticsStatCard
        className="admin-analytics-purchase-conversion"
        label="Conversión a compra"
        help={PURCHASE_CONVERSION_HELP}
        value={current ? formatRate(purchaseConversion(current)) : null}
        detail={current ? `${sessionsLabel(current.funnelPurchase)} con compra` : ""}
        loadError={loadError}
        change={line(change(report, (now, before) => compareRate(purchaseConversion(now), purchaseConversion(before))))}
      />
      <AnalyticsStatCard
        className="admin-analytics-purchases"
        label="Compras completadas"
        help={PURCHASES_HELP}
        value={current ? countFormatter.format(current.purchases) : null}
        detail={current ? `${countFormatter.format(current.attributedPurchases)} atribuibles · ${formatRevenue(current.attributedRevenue)} atribuidos` : ""}
        loadError={loadError}
        change={line(change(report, (now, before) => compareMetric(now.purchases, before.purchases)))}
      />
      <AnalyticsStatCard
        className="admin-analytics-abandoned"
        label="Carritos abandonados"
        help={ABANDONMENT_HELP}
        value={current ? countFormatter.format(abandonedTotal(current)) : null}
        detail={current ? `Tasa de abandono ${formatRate(abandonmentRate(current))}` : ""}
        loadError={loadError}
        change={line(change(report, (now, before) => compareRate(abandonmentRate(now), abandonmentRate(before))), false)}
      />
    </div>
  )
}

function Funnel({ period }: { period: CommercePeriod }) {
  return (
    <ol className="admin-analytics-funnel" aria-label="Funnel de conversión por sesiones">
      {funnelStages(period).map((stage, index) => {
        const share = formatRate(stage.fromStart)
        return (
          <li key={stage.key} className="admin-analytics-funnel-step" data-stage={stage.key}>
            <div className="flex min-w-0 items-baseline justify-between gap-2">
              <span className="truncate text-sm font-bold text-white">{stage.label}</span>
              <span className="shrink-0 text-sm font-black tabular-nums text-white">
                {countFormatter.format(stage.sessions)} <span className="text-11px font-semibold text-white/55">{stage.sessions === 1 ? "sesión" : "sesiones"}</span>
              </span>
            </div>
            <span className="admin-analytics-funnel-track" aria-hidden="true">
              <span className="admin-analytics-funnel-bar" style={{ width: `${(stage.fromStart ?? 0) * 100}%` }} />
            </span>
            <p className="text-11px font-semibold tabular-nums text-white/55">
              {index === 0 ? `${share} · inicio del funnel` : `${share} del inicio · ${formatRate(stage.fromPrevious)} de la etapa anterior`}
            </p>
          </li>
        )
      })}
    </ol>
  )
}

function CartDetail({ report }: { report: CommerceReport }) {
  const current = report.current
  if (!current) return null
  const changeOf = (pick: (period: CommercePeriod) => number) => change(report, (now, before) => compareMetric(pick(now), pick(before)))
  const rows = [
    { key: "carts", label: "Sesiones con carrito", value: current.cartSessions, change: changeOf((period) => period.cartSessions) },
    { key: "checkouts", label: "Checkouts iniciados", value: current.checkoutSessions, change: changeOf((period) => period.checkoutSessions) },
    { key: "abandoned-carts", label: "Abandonados antes del checkout", value: current.abandonedCarts, change: null },
    { key: "abandoned-checkouts", label: "Checkouts abandonados", value: current.abandonedCheckouts, change: null },
    { key: "in-progress", label: `En curso (menos de ${ABANDONMENT_WINDOW_HOURS} h)`, value: current.cartsInProgress, change: null },
  ]
  return (
    <dl className="admin-analytics-cart-detail">
      {rows.map((row) => (
        <div key={row.key} className="admin-analytics-cart-detail-row" data-row={row.key}>
          <dt className="min-w-0 text-sm font-semibold text-white/75">
            {row.label}
            {row.change && <ChangeLine change={row.change} previousRange={report.previousRange} />}
          </dt>
          <dd className="text-right text-sm font-black tabular-nums text-white">{countFormatter.format(row.value)}</dd>
        </div>
      ))}
    </dl>
  )
}

/** Funnel y detalle de carritos/checkout (mismo reporte que las cards). */
export function CommerceSection({ report, loadError }: AnalyticsReportState<CommerceReport>) {
  const current = report?.current ?? null
  const body = (content: (period: CommercePeriod) => ReactNode) =>
    current ? content(current) : loadError ? <p className="text-xs font-semibold text-white/55">{loadError}</p> : <AdminSkeleton rows={3} />

  return (
    <div className="grid min-w-0 items-start gap-4 xl:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
      <section className="admin-dashboard-filters admin-analytics-funnel-section min-w-0 rounded-2xl border p-4" aria-labelledby="analytics-funnel-title" aria-busy={!report && !loadError}>
        <h2 id="analytics-funnel-title" className="mb-3 flex items-center gap-1 text-sm font-black text-white">
          Funnel de conversión
          <AdminHelpTip label="Funnel de conversión" text={FUNNEL_HELP} />
        </h2>
        {body((period) => (
          <>
            <Funnel period={period} />
            {period.viewedSessions === 0 && (
              <p className="mt-2 text-center text-xs font-semibold text-white/55">Sin sesiones con visualizaciones en este período</p>
            )}
          </>
        ))}
      </section>
      <section className="admin-dashboard-filters admin-analytics-cart-section min-w-0 rounded-2xl border p-4" aria-labelledby="analytics-cart-title" aria-busy={!report && !loadError}>
        <h2 id="analytics-cart-title" className="mb-3 flex items-center gap-1 text-sm font-black text-white">
          Carritos y checkout
          <AdminHelpTip label="Carritos y checkout" text={ABANDONMENT_HELP} />
        </h2>
        {report && current ? <CartDetail report={report} /> : body(() => null)}
      </section>
    </div>
  )
}
