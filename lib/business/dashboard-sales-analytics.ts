import { argentinaDateKey } from "./dashboard-timezone.ts"

/**
 * Helpers puros del Análisis comercial del dashboard: períodos, agrupación
 * temporal (día/semana/mes) y conteo de operaciones. Trabajan sobre claves
 * de fecha `YYYY-MM-DD` en hora de Argentina, la misma convención que el
 * resto de las métricas del dashboard.
 */

export const SALES_CHANNELS = [
  { key: "web", label: "BEYONIX Web", source: "BEYONIX Web" },
  { key: "ml", label: "Mercado Libre", source: "MercadoLibre Marketplace" },
  { key: "external", label: "Ventas externas", source: "Ventas externas" },
] as const

export type SalesChannelKey = (typeof SALES_CHANNELS)[number]["key"]
export type SalesChannelSource = (typeof SALES_CHANNELS)[number]["source"]
export type SalesGrouping = "day" | "week" | "month"
export type SalesPeriodPreset =
  | "7d"
  | "30d"
  | "90d"
  | "month"
  | "prev-month"
  | "year"
  | "12m"
  | "all"
  | "custom"

export interface SalesDateRange {
  from: string
  to: string
}

export interface CommercialSaleLike {
  id: string
  date: string
  channel: SalesChannelSource
  /** null: facturación no determinable (reversión sin atribuir). */
  grossAmount: number | null
  productName: string
  categoryName: string | null
  orderId: string | null
}

export interface SalesEvolutionPoint {
  key: string
  start: string
  end: string
  values: Record<SalesChannelKey, number>
  total: number
  /** El bucket no está cubierto completo por el período (inicio/fin recortado o en curso). */
  partial: boolean
  /**
   * Canales con alguna venta de facturación no determinable en el bucket:
   * su valor (y el total) sólo suma la parte determinable y no es exacto.
   */
  undeterminedChannels: SalesChannelKey[]
}

export const SALES_PERIOD_PRESETS: { value: SalesPeriodPreset; label: string }[] = [
  { value: "7d", label: "Últimos 7 días" },
  { value: "30d", label: "Últimos 30 días" },
  { value: "90d", label: "Últimos 90 días" },
  { value: "month", label: "Mes en curso" },
  { value: "prev-month", label: "Mes anterior" },
  { value: "year", label: "Año en curso" },
  { value: "12m", label: "Últimos 12 meses" },
  { value: "all", label: "Todo el historial" },
  { value: "custom", label: "Personalizado" },
]

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/

export function isDateKey(value: string) {
  return DATE_KEY.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
}

function toUtcDate(key: string) {
  return new Date(`${key}T00:00:00Z`)
}

function toKey(date: Date) {
  return date.toISOString().slice(0, 10)
}

export function addDays(key: string, days: number) {
  const date = toUtcDate(key)
  date.setUTCDate(date.getUTCDate() + days)
  return toKey(date)
}

function lastDayOfMonth(year: number, monthIndex: number) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate()
}

/** Suma meses conservando el día cuando existe (31/03 - 1 mes = 28/02). */
export function addMonths(key: string, months: number) {
  const [year, month, day] = key.split("-").map(Number)
  const target = new Date(Date.UTC(year, month - 1 + months, 1))
  const targetDay = Math.min(
    day,
    lastDayOfMonth(target.getUTCFullYear(), target.getUTCMonth()),
  )
  target.setUTCDate(targetDay)
  return toKey(target)
}

export function daysBetweenInclusive(range: SalesDateRange) {
  return (
    Math.round(
      (toUtcDate(range.to).getTime() - toUtcDate(range.from).getTime()) /
        86_400_000,
    ) + 1
  )
}

/**
 * Traduce un preset al rango concreto. Devuelve `null` si el rango
 * personalizado es inválido (fechas mal formadas o "desde" > "hasta").
 */
export function resolveSalesPeriod(
  preset: SalesPeriodPreset,
  todayKey: string,
  custom: SalesDateRange,
  firstSaleKey: string | null,
): SalesDateRange | null {
  const monthStart = `${todayKey.slice(0, 7)}-01`

  switch (preset) {
    case "7d":
      return { from: addDays(todayKey, -6), to: todayKey }
    case "30d":
      return { from: addDays(todayKey, -29), to: todayKey }
    case "90d":
      return { from: addDays(todayKey, -89), to: todayKey }
    case "month":
      return { from: monthStart, to: todayKey }
    case "prev-month": {
      const from = addMonths(monthStart, -1)
      return { from, to: addDays(monthStart, -1) }
    }
    case "year":
      return { from: `${todayKey.slice(0, 4)}-01-01`, to: todayKey }
    case "12m":
      return { from: addDays(addMonths(todayKey, -12), 1), to: todayKey }
    case "all": {
      const from = firstSaleKey && firstSaleKey < todayKey ? firstSaleKey : todayKey
      return { from, to: todayKey }
    }
    case "custom": {
      const from = custom.from || firstSaleKey || todayKey
      const to = custom.to || todayKey
      if (!isDateKey(from) || !isDateKey(to) || from > to) return null
      return { from, to }
    }
  }
}

/**
 * Período de referencia para la variación. Meses y años se comparan con el
 * mismo tramo del período anterior (1–14 oct vs. 1–14 sep); los rangos
 * móviles, con la ventana de igual largo inmediatamente anterior. "Todo el
 * historial" no tiene período comparable.
 */
export function getComparisonPeriod(
  preset: SalesPeriodPreset,
  range: SalesDateRange,
): SalesDateRange | null {
  if (preset === "all") return null
  if (preset === "month") {
    return { from: addMonths(range.from, -1), to: addMonths(range.to, -1) }
  }
  if (preset === "prev-month") {
    const from = addMonths(range.from, -1)
    return { from, to: getBucketEnd(from, "month") }
  }
  if (preset === "year") {
    return { from: addMonths(range.from, -12), to: addMonths(range.to, -12) }
  }
  const length = daysBetweenInclusive(range)
  return { from: addDays(range.from, -length), to: addDays(range.from, -1) }
}

export function suggestSalesGrouping(range: SalesDateRange): SalesGrouping {
  const days = daysBetweenInclusive(range)
  if (days <= 45) return "day"
  if (days <= 210) return "week"
  return "month"
}

/** Semanas de lunes a domingo; la clave es la fecha del lunes. */
export function getBucketStart(dateKey: string, grouping: SalesGrouping) {
  if (grouping === "day") return dateKey
  if (grouping === "month") return `${dateKey.slice(0, 7)}-01`
  const weekday = toUtcDate(dateKey).getUTCDay()
  return addDays(dateKey, -((weekday + 6) % 7))
}

export function getBucketEnd(startKey: string, grouping: SalesGrouping) {
  if (grouping === "day") return startKey
  if (grouping === "week") return addDays(startKey, 6)
  return addDays(addMonths(startKey, 1), -1)
}

function nextBucket(startKey: string, grouping: SalesGrouping) {
  if (grouping === "day") return addDays(startKey, 1)
  if (grouping === "week") return addDays(startKey, 7)
  return addMonths(startKey, 1)
}

export function emptyChannelValues(): Record<SalesChannelKey, number> {
  return { web: 0, ml: 0, external: 0 }
}

export function getChannelKey(source: string): SalesChannelKey | null {
  return SALES_CHANNELS.find((channel) => channel.source === source)?.key ?? null
}

/**
 * Serie temporal continua: todos los buckets del rango existen (los días sin
 * ventas valen 0, no se omiten) para que el eje X sea calendario real.
 */
export function buildSalesEvolution(
  sales: Pick<CommercialSaleLike, "date" | "channel" | "grossAmount">[],
  range: SalesDateRange,
  grouping: SalesGrouping,
): SalesEvolutionPoint[] {
  if (!isDateKey(range.from) || !isDateKey(range.to) || range.from > range.to) {
    return []
  }

  const points: SalesEvolutionPoint[] = []
  const indexByKey = new Map<string, number>()
  let cursor = getBucketStart(range.from, grouping)

  while (cursor <= range.to) {
    const end = getBucketEnd(cursor, grouping)
    indexByKey.set(cursor, points.length)
    points.push({
      key: cursor,
      start: cursor < range.from ? range.from : cursor,
      end: end > range.to ? range.to : end,
      values: emptyChannelValues(),
      total: 0,
      partial: cursor < range.from || end > range.to,
      undeterminedChannels: [],
    })
    cursor = nextBucket(cursor, grouping)
  }

  for (const sale of sales) {
    const dateKey = argentinaDateKey(sale.date)
    if (dateKey < range.from || dateKey > range.to) continue
    const channel = getChannelKey(sale.channel)
    const index = indexByKey.get(getBucketStart(dateKey, grouping))
    if (!channel || index === undefined) continue
    if (sale.grossAmount == null) {
      if (!points[index].undeterminedChannels.includes(channel)) {
        points[index].undeterminedChannels.push(channel)
      }
      continue
    }
    const amount = Number.isFinite(sale.grossAmount) ? sale.grossAmount : 0
    points[index].values[channel] += amount
    points[index].total += amount
  }

  return points
}

export interface CommercialSalesFilter {
  range: SalesDateRange | null
  channel: SalesChannelSource | "todos"
  product: string
  category: string
}

export function filterCommercialSales<T extends CommercialSaleLike>(
  sales: T[],
  filter: CommercialSalesFilter,
): T[] {
  return sales.filter((sale) => {
    if (filter.range) {
      const dateKey = argentinaDateKey(sale.date)
      if (dateKey < filter.range.from || dateKey > filter.range.to) return false
    }
    return (
      (filter.channel === "todos" || sale.channel === filter.channel) &&
      (!filter.product || sale.productName === filter.product) &&
      (!filter.category || sale.categoryName === filter.category)
    )
  })
}

/**
 * Una venta web se informa por línea de producto; una operación es el pedido.
 * Mercado Libre agrupa por `orderId`. Las ventas externas se cuentan por fila
 * porque su referencia es texto libre y puede repetirse entre operaciones.
 * Un pedido revertido por completo (NC autorizada, importe 0) no es operación.
 * Un pedido con facturación no determinable sigue contando: la venta existió
 * y lo que está en duda es cuánto se revirtió.
 */
export function countSaleOperations(
  sales: Pick<CommercialSaleLike, "id" | "channel" | "orderId" | "grossAmount">[],
) {
  const amounts = new Map<string, number | null>()
  for (const sale of sales) {
    const channel = getChannelKey(sale.channel) ?? "unknown"
    const operation =
      channel === "external" ? sale.id : (sale.orderId ?? sale.id)
    const key = `${channel}:${operation}`
    const stored = amounts.get(key)
    const current = stored === undefined ? 0 : stored
    amounts.set(key, current == null || sale.grossAmount == null ? null : current + sale.grossAmount)
  }
  let count = 0
  for (const amount of amounts.values()) if (amount == null || amount > 0) count += 1
  return count
}

/** Escala "linda" (1, 2, 2,5, 5 × 10ⁿ) para el eje monetario. */
export function getNiceAxis(maxValue: number, targetTicks = 4) {
  if (!Number.isFinite(maxValue) || maxValue <= 0) {
    return { max: 1, ticks: [0, 1] }
  }
  const rawStep = maxValue / targetTicks
  const magnitude = 10 ** Math.floor(Math.log10(rawStep))
  const step =
    [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find(
      (candidate) => candidate >= rawStep,
    ) ?? 10 * magnitude
  const max = Math.ceil(maxValue / step) * step
  const ticks: number[] = []
  for (let value = 0; value <= max + step / 2; value += step) {
    ticks.push(Number(value.toFixed(6)))
  }
  return { max, ticks }
}

export function getVariationPercent(current: number, previous: number) {
  if (previous <= 0) return null
  return ((current - previous) / previous) * 100
}
