"use client"

import { useEffect, useId, useMemo, useRef, useState } from "react"
import { BarChart3, Download, Table2 } from "lucide-react"

import {
  buildSalesEvolution,
  getNiceAxis,
  SALES_CHANNELS,
  suggestSalesGrouping,
  type CommercialSaleLike,
  type SalesChannelKey,
  type SalesChannelSource,
  type SalesDateRange,
  type SalesEvolutionPoint,
  type SalesGrouping,
} from "@/lib/business/dashboard-sales-analytics"
import { AdminHelpTip } from "../../components/admin-help-tip"
import { formatPrice } from "../productos/helpers"

type SeriesId = SalesChannelKey | "total"
type ChartView = "total" | "channels"

interface ChartSeries {
  id: SeriesId
  label: string
  color: string
  valueOf: (point: SalesEvolutionPoint) => number
  periodTotal: number
}

const SERIES_COLOR: Record<SeriesId, string> = {
  total: "var(--sales-chart-total)",
  web: "var(--sales-chart-web)",
  ml: "var(--sales-chart-ml)",
  external: "var(--sales-chart-external)",
}

const GROUPING_OPTIONS: { value: SalesGrouping; label: string }[] = [
  { value: "day", label: "Día" },
  { value: "week", label: "Semana" },
  { value: "month", label: "Mes" },
]

const HIDDEN_AMOUNT = "$******"
const PADDING = { top: 16, right: 18, bottom: 30, left: 66 }

function parseKey(key: string) {
  const [year, month, day] = key.split("-").map(Number)
  return new Date(Date.UTC(year, month - 1, day))
}

function formatKey(key: string, options: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat("es-AR", { timeZone: "UTC", ...options })
    .format(parseKey(key))
    .replaceAll(".", "")
}

function formatAxisDate(point: SalesEvolutionPoint, grouping: SalesGrouping) {
  if (grouping === "month") return formatKey(point.key, { month: "short", year: "numeric" })
  return formatKey(point.start, { day: "numeric", month: "short" })
}

export function formatBucketLabel(point: SalesEvolutionPoint, grouping: SalesGrouping) {
  if (grouping === "day") {
    return formatKey(point.key, { weekday: "long", day: "numeric", month: "long", year: "numeric" })
  }
  const start = formatKey(point.start, { day: "numeric", month: "short" })
  const end = `${formatKey(point.end, { day: "numeric", month: "short" })} ${point.end.slice(0, 4)}`
  if (grouping === "week") return `Semana del ${start} al ${end}`
  const month = formatKey(point.key, { month: "long", year: "numeric" })
  return point.partial ? `${month} · parcial (${start} – ${end})` : month
}

function formatAxisAmount(value: number, hidden: boolean) {
  if (hidden) return value === 0 ? "$0" : "$•••"
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value)
}

function amount(value: number, hidden: boolean) {
  return hidden ? HIDDEN_AMOUNT : formatPrice(value)
}

function SegmentedControl<T extends string>({
  label,
  value,
  options,
  disabled = false,
  onChange,
}: {
  label: string
  value: T
  options: { value: T; label: string }[]
  disabled?: boolean
  onChange: (value: T) => void
}) {
  return (
    <div role="group" aria-label={label} className="admin-dash-segmented">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
          className="admin-dash-segmented-option"
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function SalesEvolutionChart({
  sales,
  range,
  channelFilter,
  hidden,
}: {
  sales: Pick<CommercialSaleLike, "date" | "channel" | "grossAmount">[]
  range: SalesDateRange | null
  channelFilter: SalesChannelSource | "todos"
  hidden: boolean
}) {
  const gradientId = useId().replaceAll(":", "")
  const viewportRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(760)
  const [view, setView] = useState<ChartView>("channels")
  const [groupingChoice, setGroupingChoice] = useState<SalesGrouping | null>(null)
  const [mutedChannels, setMutedChannels] = useState<SalesChannelKey[]>([])
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const [showTable, setShowTable] = useState(false)

  useEffect(() => {
    const element = viewportRef.current
    if (!element) return
    const update = () => setWidth(Math.max(280, element.clientWidth))
    update()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const grouping = groupingChoice ?? (range ? suggestSalesGrouping(range) : "day")
  const points = useMemo(
    () => (range ? buildSalesEvolution(sales, range, grouping) : []),
    [grouping, range, sales],
  )
  const singleChannel = channelFilter !== "todos"
  const effectiveView: ChartView = singleChannel ? "total" : view
  const lockedChannel = SALES_CHANNELS.find((channel) => channel.source === channelFilter)

  const channelSeries = useMemo<ChartSeries[]>(
    () =>
      SALES_CHANNELS.map((channel) => ({
        id: channel.key,
        label: channel.label,
        color: SERIES_COLOR[channel.key],
        valueOf: (point: SalesEvolutionPoint) => point.values[channel.key],
        periodTotal: points.reduce((sum, point) => sum + point.values[channel.key], 0),
      })),
    [points],
  )
  const periodTotal = useMemo(
    () => points.reduce((sum, point) => sum + point.total, 0),
    [points],
  )
  const series = useMemo<ChartSeries[]>(() => {
    if (effectiveView === "total") {
      return [
        {
          id: lockedChannel?.key ?? "total",
          label: lockedChannel?.label ?? "Total",
          color: SERIES_COLOR[lockedChannel?.key ?? "total"],
          valueOf: (point: SalesEvolutionPoint) => point.total,
          periodTotal,
        },
      ]
    }
    return channelSeries.filter(
      (item) =>
        item.periodTotal > 0 &&
        !mutedChannels.includes(item.id as SalesChannelKey),
    )
  }, [channelSeries, effectiveView, lockedChannel, mutedChannels, periodTotal])

  const height = width < 640 ? 230 : 290
  const plotWidth = width - PADDING.left - PADDING.right
  const plotHeight = height - PADDING.top - PADDING.bottom
  const maxValue = Math.max(
    0,
    ...series.flatMap((item) => points.map((point) => item.valueOf(point))),
  )
  const axis = getNiceAxis(maxValue, width < 640 ? 3 : 4)
  const xAt = (index: number) =>
    points.length <= 1
      ? PADDING.left + plotWidth / 2
      : PADDING.left + (index / (points.length - 1)) * plotWidth
  const yAt = (value: number) =>
    PADDING.top + plotHeight - (value / axis.max) * plotHeight

  const labelWidth = grouping === "month" ? 78 : 58
  const tickStep = Math.max(1, Math.ceil(points.length / Math.max(1, Math.floor(plotWidth / labelWidth))))
  const xTicks = points
    .map((point, index) => ({ point, index }))
    .filter(({ index }) => index % tickStep === 0)

  const lastPoint = points.at(-1)
  const lastIsPartial = Boolean(lastPoint?.partial && points.length > 1)
  const showMarkers = points.length <= 45 && plotWidth / Math.max(1, points.length) >= 12
  const hasSales = periodTotal > 0

  const buildPath = (item: ChartSeries, from: number, to: number) =>
    points
      .slice(from, to + 1)
      .map((point, offset) => `${offset ? "L" : "M"} ${xAt(from + offset).toFixed(1)} ${yAt(item.valueOf(point)).toFixed(1)}`)
      .join(" ")

  const solidEnd = lastIsPartial ? points.length - 2 : points.length - 1
  const activePoint = activeIndex === null ? null : points[activeIndex] ?? null
  const tooltipRows = activePoint
    ? [...series]
        .map((item) => ({ item, value: item.valueOf(activePoint) }))
        .sort((a, b) => b.value - a.value)
    : []

  const moveActive = (index: number) =>
    setActiveIndex(Math.max(0, Math.min(points.length - 1, index)))

  const exportCsv = () => {
    const columns = effectiveView === "total" ? series : channelSeries
    const header = ["Desde", "Hasta", ...columns.map((item) => item.label), ...(effectiveView === "total" ? [] : ["Total"])]
    const rows = points.map((point) => [
      point.start,
      point.end,
      ...columns.map((item) => item.valueOf(point).toFixed(2)),
      ...(effectiveView === "total" ? [] : [point.total.toFixed(2)]),
    ])
    const escape = (value: string) => `"${value.replaceAll('"', '""')}"`
    const csv = [header, ...rows].map((row) => row.map(escape).join(";")).join("\r\n")
    const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8" }))
    const link = document.createElement("a")
    link.href = url
    link.download = `ventas-${grouping}-${range?.from ?? ""}_${range?.to ?? ""}.csv`
    link.click()
    URL.revokeObjectURL(url)
  }

  const tooltipLeft = activeIndex === null ? 0 : xAt(activeIndex)
  const tooltipOnLeft = tooltipLeft > width / 2

  return (
    <section className="admin-sales-chart rounded-2xl border p-4" aria-labelledby="sales-chart-title" data-sales-chart>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <p className="mb-0.5 text-11px font-bold uppercase tracking-widest text-beyonix-cyan">Evolución</p>
          <h2 id="sales-chart-title" className="flex items-center gap-1.5 text-lg font-black text-white">
            Ventas en el tiempo
            <AdminHelpTip
              label="Ventas en el tiempo"
              text="Facturación bruta por fecha de venta: pago confirmado en web (neto de notas de crédito autorizadas), fecha de venta en Mercado Libre y ventas externas. No descuenta comisiones ni envíos."
            />
          </h2>
          <p className="mt-0.5 text-xs text-white/52">
            {effectiveView === "channels"
              ? "Una línea por canal. Tocá un canal en la leyenda para ocultarlo."
              : singleChannel
                ? `Solo ${lockedChannel?.label ?? "el canal filtrado"}.`
                : "Suma de todos los canales."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl
            label="Series del gráfico"
            value={effectiveView}
            disabled={singleChannel}
            options={[
              { value: "channels", label: "Por canal" },
              { value: "total", label: "Total" },
            ]}
            onChange={setView}
          />
          <SegmentedControl
            label="Agrupar por"
            value={grouping}
            options={GROUPING_OPTIONS}
            onChange={(value) => {
              setGroupingChoice(value)
              setActiveIndex(null)
            }}
          />
          <button
            type="button"
            aria-pressed={showTable}
            onClick={() => setShowTable((current) => !current)}
            className="admin-dash-chip-button"
            disabled={!hasSales}
          >
            <Table2 className="size-3.5" aria-hidden="true" />
            Tabla
          </button>
          <button
            type="button"
            onClick={exportCsv}
            className="admin-dash-chip-button"
            disabled={!hasSales || hidden}
            title={hidden ? "Mostrá los valores para exportar" : "Exportar la serie visible a CSV"}
          >
            <Download className="size-3.5" aria-hidden="true" />
            CSV
          </button>
        </div>
      </div>

      {effectiveView === "channels" && hasSales && (
        <div className="mt-3 flex flex-wrap gap-2" aria-label="Canales del gráfico">
          {channelSeries.map((item) => {
            const muted = mutedChannels.includes(item.id as SalesChannelKey)
            const empty = item.periodTotal <= 0
            return (
              <button
                key={item.id}
                type="button"
                aria-pressed={!muted && !empty}
                disabled={empty}
                onClick={() =>
                  setMutedChannels((current) =>
                    current.includes(item.id as SalesChannelKey)
                      ? current.filter((key) => key !== item.id)
                      : [...current, item.id as SalesChannelKey],
                  )
                }
                className="admin-dash-legend-item"
                data-muted={muted || empty ? "true" : undefined}
              >
                <span className="admin-dash-legend-key" style={{ backgroundColor: item.color }} aria-hidden="true" />
                <span className="text-white/72">{item.label}</span>
                <span className="font-black tabular-nums text-white">
                  {empty ? "Sin ventas" : amount(item.periodTotal, hidden)}
                </span>
              </button>
            )
          })}
        </div>
      )}

      <div ref={viewportRef} className="relative mt-3 min-w-0">
        {!range ? (
          <ChartEmpty title="Rango de fechas inválido" description="Revisá que “Desde” no sea posterior a “Hasta”." />
        ) : !hasSales ? (
          <ChartEmpty
            title="Sin ventas en este período"
            description="Probá con un período más amplio o quitá filtros de canal, producto o categoría."
          />
        ) : series.length === 0 ? (
          <ChartEmpty title="Todos los canales están ocultos" description="Activá al menos un canal en la leyenda." />
        ) : (
          <>
            <svg
              width={width}
              height={height}
              viewBox={`0 0 ${width} ${height}`}
              role="img"
              aria-label={`Evolución de ventas ${effectiveView === "channels" ? "por canal" : "total"}, agrupada por ${GROUPING_OPTIONS.find((option) => option.value === grouping)?.label.toLowerCase()}.`}
              className="block max-w-full touch-pan-y select-none"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft") moveActive((activeIndex ?? points.length) - 1)
                else if (event.key === "ArrowRight") moveActive((activeIndex ?? -1) + 1)
                else if (event.key === "Home") moveActive(0)
                else if (event.key === "End") moveActive(points.length - 1)
                else if (event.key === "Escape") setActiveIndex(null)
                else return
                event.preventDefault()
              }}
              onFocus={() => setActiveIndex((current) => current ?? points.length - 1)}
              onBlur={() => setActiveIndex(null)}
            >
              <defs>
                <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor={series[0].color} stopOpacity="0.22" />
                  <stop offset="100%" stopColor={series[0].color} stopOpacity="0" />
                </linearGradient>
              </defs>

              {axis.ticks.map((tick) => (
                <g key={tick}>
                  <line
                    x1={PADDING.left}
                    x2={width - PADDING.right}
                    y1={yAt(tick)}
                    y2={yAt(tick)}
                    stroke={tick === 0 ? "var(--sales-chart-baseline)" : "var(--sales-chart-grid)"}
                  />
                  <text x={PADDING.left - 10} y={yAt(tick) + 4} textAnchor="end" className="admin-sales-chart-axis">
                    {formatAxisAmount(tick, hidden)}
                  </text>
                </g>
              ))}

              {xTicks.map(({ point, index }) => (
                <text
                  key={point.key}
                  x={xAt(index)}
                  y={height - 8}
                  textAnchor={points.length === 1 ? "middle" : index === 0 ? "start" : "middle"}
                  className="admin-sales-chart-axis"
                >
                  {formatAxisDate(point, grouping)}
                </text>
              ))}

              {series.length === 1 && points.length > 1 && (
                <path
                  d={`${buildPath(series[0], 0, points.length - 1)} L ${xAt(points.length - 1)} ${yAt(0)} L ${xAt(0)} ${yAt(0)} Z`}
                  fill={`url(#${gradientId})`}
                />
              )}

              {series.map((item) => (
                <g key={item.id}>
                  {solidEnd > 0 && (
                    <path d={buildPath(item, 0, solidEnd)} fill="none" stroke={item.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
                  )}
                  {lastIsPartial && (
                    <path
                      d={buildPath(item, points.length - 2, points.length - 1)}
                      fill="none"
                      stroke={item.color}
                      strokeWidth="2"
                      strokeDasharray="4 4"
                      strokeLinecap="round"
                    />
                  )}
                  {(showMarkers || points.length === 1) &&
                    points.map((point, index) => (
                      <circle
                        key={point.key}
                        cx={xAt(index)}
                        cy={yAt(item.valueOf(point))}
                        r={points.length === 1 ? 5 : 3}
                        fill={item.color}
                        stroke="var(--sales-chart-surface)"
                        strokeWidth="2"
                      />
                    ))}
                </g>
              ))}

              {activePoint && activeIndex !== null && (
                <g pointerEvents="none">
                  <line
                    x1={xAt(activeIndex)}
                    x2={xAt(activeIndex)}
                    y1={PADDING.top}
                    y2={PADDING.top + plotHeight}
                    stroke="var(--sales-chart-crosshair)"
                  />
                  {series.map((item) => (
                    <circle
                      key={item.id}
                      cx={xAt(activeIndex)}
                      cy={yAt(item.valueOf(activePoint))}
                      r="5"
                      fill={item.color}
                      stroke="var(--sales-chart-surface)"
                      strokeWidth="2"
                    />
                  ))}
                </g>
              )}

              <rect
                x={PADDING.left}
                y={PADDING.top}
                width={Math.max(0, plotWidth)}
                height={Math.max(0, plotHeight)}
                fill="transparent"
                onPointerMove={(event) => {
                  const bounds = event.currentTarget.getBoundingClientRect()
                  const ratio = bounds.width > 0 ? (event.clientX - bounds.left) / bounds.width : 0
                  moveActive(Math.round(ratio * (points.length - 1)))
                }}
                onPointerLeave={(event) => {
                  if (event.pointerType === "mouse") setActiveIndex(null)
                }}
              />
            </svg>

            {activePoint && (
              <div
                role="status"
                className="admin-sales-chart-tooltip"
                style={{
                  top: PADDING.top,
                  ...(tooltipOnLeft
                    ? { right: Math.max(4, width - tooltipLeft + 14) }
                    : { left: Math.min(Math.max(4, tooltipLeft + 14), Math.max(4, width - 220)) }),
                }}
              >
                <p className="admin-sales-chart-tooltip-title">{formatBucketLabel(activePoint, grouping)}</p>
                {tooltipRows.map(({ item, value }) => (
                  <p key={item.id} className="admin-sales-chart-tooltip-row">
                    <span className="admin-dash-legend-key" style={{ backgroundColor: item.color }} aria-hidden="true" />
                    <span className="admin-sales-chart-tooltip-value">{amount(value, hidden)}</span>
                    <span className="admin-sales-chart-tooltip-label">{item.label}</span>
                  </p>
                ))}
                {effectiveView === "channels" && series.length > 1 && (
                  <p className="admin-sales-chart-tooltip-row admin-sales-chart-tooltip-total">
                    <span className="admin-sales-chart-tooltip-value">
                      {amount(series.reduce((sum, item) => sum + item.valueOf(activePoint), 0), hidden)}
                    </span>
                    <span className="admin-sales-chart-tooltip-label">Total visible</span>
                  </p>
                )}
              </div>
            )}

            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-11px text-white/45">
              <span>
                {points.length} {grouping === "day" ? "días" : grouping === "week" ? "semanas" : "meses"} · pasá el cursor o usá ← → para ver cada valor
              </span>
              {lastIsPartial && (
                <span className="inline-flex items-center gap-1.5">
                  <svg width="18" height="4" aria-hidden="true">
                    <line x1="0" x2="18" y1="2" y2="2" stroke="currentColor" strokeWidth="2" strokeDasharray="4 3" />
                  </svg>
                  Último tramo incompleto (período en curso o recortado)
                </span>
              )}
            </div>
          </>
        )}
      </div>

      {showTable && hasSales && (
        <div className="custom-scrollbar mt-3 max-h-80 overflow-auto">
          <table className="w-full min-w-[520px] text-left text-xs">
            <caption className="sr-only">Ventas por período</caption>
            <thead className="sticky top-0 bg-[var(--admin-surface)] text-10px uppercase tracking-widest text-white/50">
              <tr>
                <th scope="col" className="px-3 py-2">Período</th>
                {(effectiveView === "total" ? series : channelSeries).map((item) => (
                  <th key={item.id} scope="col" className="px-3 py-2 text-right">{item.label}</th>
                ))}
                {effectiveView === "channels" && <th scope="col" className="px-3 py-2 text-right">Total</th>}
              </tr>
            </thead>
            <tbody>
              {[...points].reverse().map((point) => (
                <tr key={point.key} className="border-t border-white/6">
                  <th scope="row" className="px-3 py-2 font-semibold text-white/72">{formatBucketLabel(point, grouping)}</th>
                  {(effectiveView === "total" ? series : channelSeries).map((item) => (
                    <td key={item.id} className="px-3 py-2 text-right tabular-nums text-white/72">{amount(item.valueOf(point), hidden)}</td>
                  ))}
                  {effectiveView === "channels" && (
                    <td className="px-3 py-2 text-right font-black tabular-nums text-white">{amount(point.total, hidden)}</td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function ChartEmpty({ title, description }: { title: string; description: string }) {
  return (
    <div className="admin-dash-empty flex min-h-56 flex-col items-center justify-center gap-2 px-4 text-center">
      <span className="flex size-10 items-center justify-center text-beyonix-sky">
        <BarChart3 className="size-5" aria-hidden="true" />
      </span>
      <p className="text-sm font-black text-white">{title}</p>
      <p className="max-w-sm text-xs leading-5 text-white/52">{description}</p>
    </div>
  )
}
