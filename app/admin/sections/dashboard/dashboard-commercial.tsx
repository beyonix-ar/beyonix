"use client"

import { useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  FilterX,
  Minus,
} from "lucide-react"

import type {
  DashboardCommercialSale,
  DashboardDataResponse,
  DashboardFinancialSummary,
} from "@/lib/supabase/queries/dashboard"
import {
  calculateOperatingResult,
  summarizeSaleFinancials,
} from "@/lib/business/commercial-sale-financials"
import { argentinaDateKey } from "@/lib/business/dashboard-timezone"
import {
  countSaleOperations,
  filterCommercialSales,
  getComparisonPeriod,
  getVariationPercent,
  resolveSalesPeriod,
  SALES_CHANNELS,
  SALES_PERIOD_PRESETS,
  type SalesChannelSource,
  type SalesDateRange,
  type SalesPeriodPreset,
} from "@/lib/business/dashboard-sales-analytics"
import { AdminDatePicker } from "../../components/admin-date-picker"
import { AdminSelect } from "../../components/admin-controls"
import { AdminHelpTip } from "../../components/admin-help-tip"
import { formatPrice } from "../productos/helpers"
import { SalesEvolutionChart } from "./sales-evolution-chart"
import { DashboardSectionHeader, FinancialMetric } from "./dashboard-ui"

type SortKey =
  | "productName"
  | "channel"
  | "paymentMethod"
  | "quantity"
  | "grossAmount"
  | "netAmount"
  | "costAmount"
  | "profitAmount"
  | "marginPercent"
  | "ticket"

const HIDDEN_AMOUNT = "$******"
const HIDE_VALUES_STORAGE_KEY = "beyonix-hide-dashboard-values"
const TABLE_LIMIT = 80
const CHANNEL_COLOR: Record<SalesChannelSource, string> = {
  "BEYONIX Web": "var(--sales-chart-web)",
  "MercadoLibre Marketplace": "var(--sales-chart-ml)",
  "Ventas externas": "var(--sales-chart-external)",
}
const TABLE_COLUMNS: { key: SortKey; label: string; numeric: boolean }[] = [
  { key: "productName", label: "Producto", numeric: false },
  { key: "channel", label: "Canal", numeric: false },
  { key: "paymentMethod", label: "Método de pago", numeric: false },
  { key: "quantity", label: "Unidades", numeric: true },
  { key: "grossAmount", label: "Facturación", numeric: true },
  { key: "netAmount", label: "Neto", numeric: true },
  { key: "costAmount", label: "Costo mercadería", numeric: true },
  { key: "profitAmount", label: "Resultado", numeric: true },
  { key: "marginPercent", label: "Margen", numeric: true },
  { key: "ticket", label: "Precio unitario", numeric: true },
]

/** null = monto no determinable (devolución sin atribuir): nunca se muestra una cota. */
function maskAmount(value: number | null, hidden: boolean) {
  if (value == null) return "Pendiente"
  return hidden ? HIDDEN_AMOUNT : formatPrice(value)
}

const UNDETERMINED_NOTE = "Hay una devolución sin atribuir."

function formatRange(range: SalesDateRange) {
  const format = (key: string, withYear: boolean) => {
    const [year, month, day] = key.split("-").map(Number)
    const label = new Intl.DateTimeFormat("es-AR", { timeZone: "UTC", day: "numeric", month: "short" })
      .format(new Date(Date.UTC(year, month - 1, day)))
      .replaceAll(".", "")
    return withYear ? `${label} ${year}` : label
  }
  if (range.from === range.to) return format(range.from, true)
  const sameYear = range.from.slice(0, 4) === range.to.slice(0, 4)
  return `${format(range.from, !sameYear)} – ${format(range.to, true)}`
}

function readHiddenPreference() {
  if (typeof window === "undefined") return true
  try {
    return window.localStorage.getItem(HIDE_VALUES_STORAGE_KEY) !== "false"
  } catch {
    return true
  }
}

/** null si alguna línea tiene facturación no determinable: una venta sana no la rescata. */
function sumAmount(rows: DashboardCommercialSale[]): number | null {
  return rows.reduce<number | null>(
    (total, sale) => (total == null || sale.grossAmount == null ? null : total + sale.grossAmount),
    0,
  )
}

function sumUnits(rows: DashboardCommercialSale[]) {
  return rows.reduce((total, sale) => total + sale.quantity, 0)
}

function formatPercent(value: number) {
  return `${value.toFixed(1).replace(".", ",")}%`
}

/**
 * "90% con costo · 8% inferido": el costo inferido no vale como costo de
 * compra. Con la lectura incompleta no se sabe qué falta: no hay porcentaje.
 */
function describeCostCoverage(coverage: number, inferred: number, complete: boolean) {
  if (!complete) return "Lectura incompleta"
  return `${formatPercent(coverage)} con costo${inferred > 0.05 ? ` · ${formatPercent(inferred)} inferido` : ""}`
}

function VariationBadge({
  current,
  previous,
  previousUndetermined = false,
  comparison,
  hidden,
}: {
  current: number | null
  previous: number | null
  /** El período de comparación incluye una facturación no determinable. */
  previousUndetermined?: boolean
  comparison: SalesDateRange | null
  hidden: boolean
}) {
  if (current === null) {
    return <p className="mt-1.5 text-11px text-amber-200/80">{UNDETERMINED_NOTE}</p>
  }
  if (comparison && previousUndetermined) {
    return (
      <p className="mt-1.5 text-11px text-white/45">
        {formatRange(comparison)} tiene una devolución sin atribuir
      </p>
    )
  }
  if (previous === null || !comparison) {
    return <p className="mt-1.5 text-11px text-white/45">Sin período comparable</p>
  }
  const variation = getVariationPercent(current, previous)
  if (variation === null) {
    return (
      <p className="mt-1.5 text-11px text-white/45">
        Sin ventas en {formatRange(comparison)}
      </p>
    )
  }
  const direction = Math.abs(variation) < 0.05 ? "flat" : variation > 0 ? "up" : "down"
  const Icon = direction === "up" ? ArrowUpRight : direction === "down" ? ArrowDownRight : Minus
  return (
    <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 text-11px text-white/52">
      <span className="admin-dash-delta" data-direction={direction}>
        <Icon className="size-3.5" aria-hidden="true" />
        {hidden ? "**%" : `${variation > 0 ? "+" : ""}${variation.toFixed(1).replace(".", ",")}%`}
      </span>
      <span>vs. {formatRange(comparison)}</span>
    </p>
  )
}

function KpiCard({
  label,
  help,
  value,
  children,
}: {
  label: string
  help: string
  value: string
  children?: React.ReactNode
}) {
  return (
    <div className="admin-dashboard-kpi min-w-0 rounded-2xl border px-4 py-3">
      <p className="flex items-center gap-1 text-10px font-black uppercase tracking-widest text-white/52">
        {label}
        <AdminHelpTip label={label} text={help} />
      </p>
      <p className="mt-1 truncate text-2xl font-black tabular-nums text-white">{value}</p>
      {children}
    </div>
  )
}

function FilterField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <span className="mb-1.5 block text-10px font-black uppercase tracking-widest text-white/50">
        {label}
      </span>
      {children}
    </div>
  )
}

export function DashboardCommercialView({
  sales,
  paidExpensesByDate,
  financialSummary,
  pendingRefundOperations,
}: {
  sales: DashboardCommercialSale[]
  paidExpensesByDate: DashboardDataResponse["paidExpensesByDate"]
  financialSummary: DashboardFinancialSummary
  pendingRefundOperations: number
}) {
  const router = useRouter()
  const [todayKey] = useState(() => argentinaDateKey(new Date()))
  const [preset, setPreset] = useState<SalesPeriodPreset>("30d")
  const [customFrom, setCustomFrom] = useState("")
  const [customTo, setCustomTo] = useState("")
  const [channel, setChannel] = useState<SalesChannelSource | "todos">("todos")
  const [product, setProduct] = useState("")
  const [category, setCategory] = useState("")
  const [sortKey, setSortKey] = useState<SortKey>("grossAmount")
  const [hidden, setHidden] = useState(readHiddenPreference)

  const firstSaleKey = useMemo(
    () =>
      sales.reduce<string | null>((first, sale) => {
        const key = argentinaDateKey(sale.date)
        return first === null || key < first ? key : first
      }, null),
    [sales],
  )
  const range = useMemo(
    () => resolveSalesPeriod(preset, todayKey, { from: customFrom, to: customTo }, firstSaleKey),
    [customFrom, customTo, firstSaleKey, preset, todayKey],
  )
  const comparison = useMemo(
    () => (range ? getComparisonPeriod(preset, range) : null),
    [preset, range],
  )
  const dimensionSales = useMemo(
    () => filterCommercialSales(sales, { range: null, channel, product, category }),
    [category, channel, product, sales],
  )
  const periodSales = useMemo(
    () => (range ? filterCommercialSales(dimensionSales, { range, channel: "todos", product: "", category: "" }) : []),
    [dimensionSales, range],
  )
  const comparisonSales = useMemo(
    () =>
      comparison
        ? filterCommercialSales(dimensionSales, { range: comparison, channel: "todos", product: "", category: "" })
        : null,
    [comparison, dimensionSales],
  )

  // Los ajustes de pedido (NC o reintegro sin ítem) no son un producto.
  const productOptions = useMemo(
    () =>
      Array.from(new Set(sales.filter((sale) => sale.kind === "sale").map((sale) => sale.productName))).sort((a, b) =>
        a.localeCompare(b, "es"),
      ),
    [sales],
  )
  const categoryOptions = useMemo(
    () =>
      Array.from(
        new Set(sales.map((sale) => sale.categoryName).filter((name): name is string => Boolean(name))),
      ).sort((a, b) => a.localeCompare(b, "es")),
    [sales],
  )

  const revenue = sumAmount(periodSales)
  const operations = countSaleOperations(periodSales)
  const units = sumUnits(periodSales)
  const ticket = revenue == null ? null : operations > 0 ? revenue / operations : 0
  const previousRevenue = comparisonSales ? sumAmount(comparisonSales) : null
  const previousRevenueUndetermined = Boolean(comparisonSales) && previousRevenue == null
  const previousOperations = comparisonSales ? countSaleOperations(comparisonSales) : null
  const previousUnits = comparisonSales ? sumUnits(comparisonSales) : null
  const previousTicket =
    previousRevenue !== null
      ? previousOperations
        ? previousRevenue / previousOperations
        : 0
      : null
  // Mismas líneas y mismas fórmulas que el resumen histórico, recortadas al período.
  const periodFinancials = useMemo(() => summarizeSaleFinancials(periodSales), [periodSales])
  const previousFinancials = comparisonSales ? summarizeSaleFinancials(comparisonSales) : null
  const previousNetSales = previousFinancials?.netSales ?? null
  const previousNetUndetermined = previousFinancials != null && previousFinancials.netSales == null
  // El backend decide si la lectura alcanza: con datos incompletos no se
  // reconstruye un resultado a partir de las líneas que sí llegaron.
  const datasetComplete = financialSummary.complete
  const periodContribution = datasetComplete ? periodFinancials.contributionResult : null
  // Los gastos generales no tienen canal ni producto: sólo se restan sin esos filtros.
  const expensesApply = channel === "todos" && !product && !category
  const periodExpenseTotals = useMemo(
    () =>
      (range ? paidExpensesByDate : []).reduce(
        (totals, expense) => {
          if (!range || expense.date < range.from || expense.date > range.to) return totals
          return {
            amount: totals.amount + expense.amount,
            costMissing: totals.costMissing || expense.costMissing,
          }
        },
        { amount: 0, costMissing: false },
      ),
    [paidExpensesByDate, range],
  )
  const periodExpenses = periodExpenseTotals.amount
  // Mercadería entregada como gasto sin costo: su costo no se asume 0.
  const periodOperatingResult = expensesApply && !periodExpenseTotals.costMissing
    ? calculateOperatingResult(periodContribution, periodExpenses)
    : null

  const quickReferences = useMemo(() => {
    const monthPrefix = todayKey.slice(0, 7)
    const yearPrefix = todayKey.slice(0, 4)
    const add = (total: number | null, value: number | null) =>
      total == null || value == null ? null : total + value
    return dimensionSales.reduce<Record<"today" | "month" | "year", number | null>>(
      (totals, sale) => {
        const key = argentinaDateKey(sale.date)
        if (key === todayKey) totals.today = add(totals.today, sale.grossAmount)
        if (key.startsWith(monthPrefix) && key <= todayKey) totals.month = add(totals.month, sale.grossAmount)
        if (key.startsWith(yearPrefix) && key <= todayKey) totals.year = add(totals.year, sale.grossAmount)
        return totals
      },
      { today: 0, month: 0, year: 0 },
    )
  }, [dimensionSales, todayKey])

  const channelMix = SALES_CHANNELS.map((item) => {
    const rows = periodSales.filter((sale) => sale.channel === item.source)
    const total = sumAmount(rows)
    return {
      ...item,
      total,
      operations: countSaleOperations(rows),
      // Sin facturación determinable no hay participación que mostrar.
      share: revenue == null || total == null ? null : revenue > 0 ? (total / revenue) * 100 : 0,
    }
  })
  const topProducts = Array.from(
    periodSales
      .filter((sale) => sale.kind === "sale")
      .reduce((map, sale) => {
        const current = map.get(sale.productName) ?? { label: sale.productName, units: 0, amount: 0 }
        current.units += sale.quantity
        current.amount = current.amount == null || sale.grossAmount == null ? null : current.amount + sale.grossAmount
        map.set(sale.productName, current)
        return map
      }, new Map<string, { label: string; units: number; amount: number | null }>())
      .values(),
  )
    .sort((a, b) => b.units - a.units || (b.amount ?? 0) - (a.amount ?? 0))
    .slice(0, 8)
  const topUnits = Math.max(1, ...topProducts.map((item) => item.units))

  const tableRows = [...periodSales].sort((a, b) => {
    const ticketA = a.quantity ? (a.grossAmount ?? 0) / a.quantity : 0
    const ticketB = b.quantity ? (b.grossAmount ?? 0) / b.quantity : 0
    const values: Record<SortKey, number> = {
      productName: a.productName.localeCompare(b.productName, "es"),
      channel: a.channel.localeCompare(b.channel, "es"),
      paymentMethod: a.paymentMethod.localeCompare(b.paymentMethod, "es"),
      quantity: b.quantity - a.quantity,
      grossAmount: (b.grossAmount ?? 0) - (a.grossAmount ?? 0),
      netAmount: (b.netAmount ?? 0) - (a.netAmount ?? 0),
      costAmount: (b.costAmount ?? 0) - (a.costAmount ?? 0),
      profitAmount: (b.profitAmount ?? 0) - (a.profitAmount ?? 0),
      marginPercent: (b.marginPercent ?? 0) - (a.marginPercent ?? 0),
      ticket: ticketB - ticketA,
    }
    return values[sortKey]
  })

  const filtersActive =
    preset !== "30d" || channel !== "todos" || Boolean(product) || Boolean(category)
  const clearFilters = () => {
    setPreset("30d")
    setCustomFrom("")
    setCustomTo("")
    setChannel("todos")
    setProduct("")
    setCategory("")
  }
  const toggleHidden = () => {
    setHidden((current) => {
      try {
        window.localStorage.setItem(HIDE_VALUES_STORAGE_KEY, current ? "false" : "true")
      } catch {
        // Preferencia solo de conveniencia: si el storage no está disponible, se aplica en memoria.
      }
      return !current
    })
  }
  const invoiceCoverage =
    financialSummary.paidOrders > 0
      ? (financialSummary.invoicedOrders / financialSummary.paidOrders) * 100
      : 100

  return (
    <div className="space-y-4">
      <section className="admin-dashboard-filters rounded-2xl border p-4" aria-labelledby="commercial-filters-title">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="mb-0.5 text-11px font-bold uppercase tracking-widest text-beyonix-cyan">Análisis comercial</p>
            <h2 id="commercial-filters-title" className="text-lg font-black text-white">
              Ventas del período
            </h2>
            <p className="mt-0.5 text-xs text-white/52">
              {range ? (
                <>
                  {formatRange(range)}
                  {comparison ? ` · comparado con ${formatRange(comparison)}` : ""}
                </>
              ) : (
                "Elegí un rango de fechas válido."
              )}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {filtersActive && (
              <button type="button" onClick={clearFilters} className="admin-dash-chip-button">
                <FilterX className="size-3.5" aria-hidden="true" />
                Limpiar filtros
              </button>
            )}
            <button
              type="button"
              aria-label={hidden ? "Mostrar valores" : "Ocultar valores"}
              aria-pressed={!hidden}
              onClick={toggleHidden}
              className="admin-dash-chip-button"
            >
              {hidden ? <Eye className="size-3.5" aria-hidden="true" /> : <EyeOff className="size-3.5" aria-hidden="true" />}
              {hidden ? "Mostrar valores" : "Ocultar valores"}
            </button>
          </div>
        </div>

        <div className="mt-3 grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
          <FilterField label="Período">
            <AdminSelect
              title="Período"
              ariaLabel="Período de análisis"
              value={preset}
              onChange={(value) => setPreset(value as SalesPeriodPreset)}
            >
              {SALES_PERIOD_PRESETS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </AdminSelect>
          </FilterField>
          <FilterField label="Canal">
            <AdminSelect
              title="Canal"
              ariaLabel="Canal de venta"
              value={channel}
              onChange={(value) => setChannel(value as SalesChannelSource | "todos")}
            >
              <option value="todos">Todos los canales</option>
              {SALES_CHANNELS.map((item) => (
                <option key={item.source} value={item.source}>
                  {item.label}
                </option>
              ))}
            </AdminSelect>
          </FilterField>
          <FilterField label="Categoría">
            <AdminSelect
              title="Categoría"
              ariaLabel="Categoría"
              value={category}
              searchable={categoryOptions.length > 7}
              searchPlaceholder="Buscar categoría..."
              onChange={setCategory}
            >
              <option value="">Todas las categorías</option>
              {categoryOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </AdminSelect>
          </FilterField>
          <FilterField label="Producto">
            <AdminSelect
              title="Producto"
              ariaLabel="Producto"
              value={product}
              searchable={productOptions.length > 7}
              searchPlaceholder="Buscar producto..."
              onChange={setProduct}
            >
              <option value="">Todos los productos</option>
              {productOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </AdminSelect>
          </FilterField>
        </div>

        {preset === "custom" && (
          <div className="mt-2.5 grid gap-2.5 sm:grid-cols-2 xl:max-w-[50%]">
            <FilterField label="Desde">
              <AdminDatePicker title="Desde" ariaLabel="Fecha inicial" value={customFrom} placeholder="Primera venta" onChange={setCustomFrom} />
            </FilterField>
            <FilterField label="Hasta">
              <AdminDatePicker title="Hasta" ariaLabel="Fecha final" value={customTo} placeholder="Hoy" onChange={setCustomTo} />
            </FilterField>
          </div>
        )}
        {!range && (
          <p role="alert" className="mt-2 text-xs font-semibold text-red-300">
            La fecha “Desde” no puede ser posterior a “Hasta”.
          </p>
        )}
        {category && (
          <p className="mt-2 text-11px text-white/45">
            Mercado Libre y ventas externas no informan categoría: con este filtro solo se ven ventas web.
          </p>
        )}

        <div className="mt-4 grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
          <KpiCard
            label="Facturación"
            help="Ventas del período menos reintegros, notas de crédito y anulaciones (también las que no corresponden a un producto). No descuenta comisiones ni envíos. Pendiente si una devolución no puede atribuirse a su nota de crédito."
            value={maskAmount(revenue, hidden)}
          >
            <VariationBadge current={revenue} previous={previousRevenue} previousUndetermined={previousRevenueUndetermined} comparison={comparison} hidden={hidden} />
          </KpiCard>
          <KpiCard
            label="Operaciones"
            help="Pedidos web, órdenes de Mercado Libre y ventas externas. Un pedido con varios productos cuenta una sola vez."
            value={operations.toLocaleString("es-AR")}
          >
            <VariationBadge current={operations} previous={previousOperations} comparison={comparison} hidden={false} />
          </KpiCard>
          <KpiCard
            label="Ticket promedio"
            help="Facturación del período dividida por la cantidad de operaciones."
            value={maskAmount(ticket, hidden)}
          >
            <VariationBadge current={ticket} previous={previousTicket} previousUndetermined={previousRevenueUndetermined} comparison={comparison} hidden={hidden} />
          </KpiCard>
          <KpiCard
            label="Unidades vendidas"
            help="Unidades vendidas en el período, netas de reversiones. Web: descuenta las acreditadas con nota de crédito. Mercado Libre: descuenta canceladas y devueltas con evidencia (revisión física o unidades informadas por ML), igual que la pantalla Ventas ML. Externas: descuenta las devoluciones dañadas."
            value={units.toLocaleString("es-AR")}
          >
            <VariationBadge current={units} previous={previousUnits} comparison={comparison} hidden={false} />
          </KpiCard>
        </div>

        <div className="mt-2.5 grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
          <KpiCard
            label="Ventas netas"
            help="Facturación menos comisiones, logística absorbida y otros gastos directos. En Mercado Libre es el Total liquidado."
            value={maskAmount(periodFinancials.netSales, hidden)}
          >
            <VariationBadge current={periodFinancials.netSales} previous={previousNetSales} previousUndetermined={previousNetUndetermined} comparison={comparison} hidden={hidden} />
          </KpiCard>
          <KpiCard
            label="Costo mercadería"
            help="Costo histórico de lo vendido (promedio ponderado a la fecha de venta). El costo inferido sale de la ganancia declarada en ventas externas históricas."
            value={maskAmount(periodFinancials.costOfGoodsSold, hidden)}
          >
            <p className="mt-1.5 text-11px text-white/52">
              {describeCostCoverage(periodFinancials.costCoveragePercent, periodFinancials.inferredCostPercent, datasetComplete)}
            </p>
          </KpiCard>
          <KpiCard
            label="Resultado comercial"
            help="Ventas netas menos costo de mercadería. Sin gastos generales. Pendiente mientras alguna venta del período no tenga costo, una devolución no pueda atribuirse a su nota de crédito o la lectura esté incompleta."
            value={periodContribution == null ? "Pendiente" : maskAmount(periodContribution, hidden)}
          >
            <p className="mt-1.5 text-11px text-white/52">
              {!datasetComplete
                ? "Lectura incompleta"
                : periodContribution == null
                  ? [
                      periodFinancials.linesWithoutCost > 0
                        ? `${periodFinancials.linesWithoutCost} ${periodFinancials.linesWithoutCost === 1 ? "línea" : "líneas"} sin costo`
                        : null,
                      periodFinancials.ambiguousReversalLines > 0 ? "Devolución sin atribuir" : null,
                    ].filter(Boolean).join(" · ")
                  : periodFinancials.contributionMarginPercent == null
                    ? "Sin facturación"
                    : `Margen ${hidden ? "**%" : formatPercent(periodFinancials.contributionMarginPercent)}`}
            </p>
          </KpiCard>
          <KpiCard
            label="Ganancia limpia"
            help="Ganancia después de costos y gastos registrados."
            value={
              !expensesApply
                ? "—"
                : periodOperatingResult == null
                  ? "Pendiente"
                  : maskAmount(periodOperatingResult, hidden)
            }
          >
            <p className="mt-1.5 text-11px text-white/52">
              {!expensesApply
                ? "Sólo con todos los canales y productos"
                : !datasetComplete
                  ? "Lectura incompleta"
                  : periodExpenseTotals.costMissing
                    ? "Falta costo de mercadería entregada como gasto"
                    : `Gastos registrados: ${maskAmount(periodExpenses, hidden)}`}
            </p>
          </KpiCard>
        </div>

        <dl
          aria-label="Referencias rápidas, sin filtro de período"
          className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-white/52"
        >
          {[
            { label: "Hoy", value: quickReferences.today },
            { label: "Mes en curso", value: quickReferences.month },
            { label: "Año en curso", value: quickReferences.year },
          ].map((item) => (
            <div key={item.label} className="flex items-center gap-1.5">
              <dt>{item.label}:</dt>
              <dd className="font-black tabular-nums text-white/85">{maskAmount(item.value, hidden)}</dd>
            </div>
          ))}
          <div className="flex items-center">
            <AdminHelpTip
              label="Referencias rápidas"
              text="Hoy, mes y año en curso con los mismos filtros de canal, categoría y producto, sin importar el período elegido."
            />
          </div>
        </dl>
      </section>

      <SalesEvolutionChart sales={dimensionSales} range={range} channelFilter={channel} hidden={hidden} />

      <div className="grid gap-4 xl:grid-cols-5">
        <section className="rounded-2xl border p-4 xl:col-span-2" aria-labelledby="channel-mix-title">
          <DashboardSectionHeader
            id="channel-mix-title"
            eyebrow="Canales"
            title="Mix de ventas"
            help="Participación de cada canal en la facturación del período."
          />
          <ul className="space-y-3">
            {channelMix.map((item) => (
              <li key={item.key}>
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="flex min-w-0 items-center gap-2 font-bold text-white">
                    <span className="admin-dash-legend-key" style={{ backgroundColor: CHANNEL_COLOR[item.source] }} aria-hidden="true" />
                    <span className="truncate">{item.label}</span>
                  </span>
                  <span className="shrink-0 text-xs font-black tabular-nums text-white">
                    {maskAmount(item.total, hidden)}
                  </span>
                </div>
                <div className="admin-dash-bar-track mt-1.5">
                  <span
                    className="admin-dash-bar"
                    style={{ width: `${item.share ?? 0}%`, backgroundColor: CHANNEL_COLOR[item.source] }}
                  />
                </div>
                <p className="mt-1 text-11px text-white/45">
                  {item.share == null ? "Pendiente" : hidden ? "**%" : `${item.share.toFixed(1).replace(".", ",")}%`} · {item.operations}{" "}
                  {item.operations === 1 ? "operación" : "operaciones"}
                </p>
              </li>
            ))}
          </ul>
        </section>

        <section className="rounded-2xl border p-4 xl:col-span-3" aria-labelledby="top-products-title">
          <DashboardSectionHeader
            id="top-products-title"
            eyebrow="Productos"
            title="Más vendidos del período"
            help="Ordenados por unidades vendidas; a igualdad, por facturación."
          />
          {topProducts.length ? (
            <ol className="space-y-2.5">
              {topProducts.map((item, index) => (
                <li key={item.label} className="grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-x-3">
                  <span className="text-xs font-black tabular-nums text-white/45">{index + 1}</span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold text-white">{item.label}</p>
                    <div className="admin-dash-bar-track mt-1">
                      <span className="admin-dash-bar" style={{ width: `${(item.units / topUnits) * 100}%` }} />
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-black tabular-nums text-white">{item.units.toLocaleString("es-AR")} u.</p>
                    <p className="text-11px tabular-nums text-white/45">{maskAmount(item.amount, hidden)}</p>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p className="py-8 text-center text-sm text-white/50">No hay ventas para los filtros seleccionados.</p>
          )}
        </section>
      </div>

      <section className="rounded-2xl border p-4" aria-labelledby="sales-detail-title">
        <DashboardSectionHeader
          id="sales-detail-title"
          eyebrow="Detalle"
          title="Ventas por línea de producto"
          description={
            tableRows.length > TABLE_LIMIT
              ? `Mostrando ${TABLE_LIMIT} de ${tableRows.length} líneas. Ajustá los filtros para acotar.`
              : `${tableRows.length} ${tableRows.length === 1 ? "línea" : "líneas"} en el período.`
          }
        />
        <div className="custom-scrollbar max-h-[34rem] overflow-auto">
          <table className="w-full min-w-[1080px] text-left text-sm">
            <thead className="sticky top-0 z-[1] bg-[var(--admin-surface)] text-11px uppercase tracking-widest text-white/50">
              <tr>
                {TABLE_COLUMNS.map((column) => (
                  <th
                    key={column.key}
                    scope="col"
                    aria-sort={sortKey === column.key ? (column.numeric ? "descending" : "ascending") : undefined}
                    className={`px-3 py-2.5 ${column.numeric ? "text-right" : "text-left"}`}
                  >
                    <button
                      type="button"
                      onClick={() => setSortKey(column.key)}
                      className={`inline-flex cursor-pointer items-center gap-1 font-black transition hover:text-white ${
                        sortKey === column.key ? "text-white" : "text-white/55"
                      }`}
                    >
                      {column.label}
                      {sortKey === column.key &&
                        (column.numeric ? <ChevronDown className="size-3.5" aria-hidden="true" /> : <ChevronUp className="size-3.5" aria-hidden="true" />)}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tableRows.slice(0, TABLE_LIMIT).map((sale) => {
                const unitPrice = sale.grossAmount == null ? null : sale.quantity ? sale.grossAmount / sale.quantity : 0
                return (
                  <tr key={sale.id} className="border-t border-white/6">
                    <td className="px-3 py-2.5 font-bold text-white">
                      <span className="block">{sale.productName}</span>
                      {sale.channel === "BEYONIX Web" && sale.orderId && (
                        <button
                          type="button"
                          onClick={() => router.push(`/admin/pedidos/${encodeURIComponent(sale.orderId!)}`)}
                          className="mt-1 cursor-pointer text-10px font-black uppercase tracking-wide text-beyonix-sky hover:text-white"
                        >
                          Ver pedido
                        </button>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-white/65">
                      <span className="inline-flex items-center gap-2">
                        <span className="admin-dash-legend-key" style={{ backgroundColor: CHANNEL_COLOR[sale.channel] }} aria-hidden="true" />
                        {SALES_CHANNELS.find((item) => item.source === sale.channel)?.label ?? sale.channel}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-white/65">{sale.paymentMethod}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-white/65">{sale.quantity}</td>
                    <td className="px-3 py-2.5 text-right font-bold tabular-nums text-white">{maskAmount(sale.grossAmount, hidden)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-white/65">{maskAmount(sale.netAmount, hidden)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-white/65">
                      {sale.costAmount == null ? "—" : maskAmount(sale.costAmount, hidden)}
                      {sale.costSource === "inferred" && (
                        <span className="block text-10px text-white/45" title="Deducido de la ganancia declarada: no es un costo de compra.">
                          inferido
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-white/65">
                      {sale.reversalAmbiguous ? (
                        <span title="Nota de crédito sin ítem y devolución sin nota: no se sabe si son la misma reversión.">Pendiente</span>
                      ) : sale.profitAmount == null ? "—" : maskAmount(sale.profitAmount, hidden)}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-white/65">
                      {hidden ? "****" : sale.marginPercent == null ? "—" : `${sale.marginPercent.toFixed(1).replace(".", ",")}%`}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-white/65">{maskAmount(unitPrice, hidden)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {!tableRows.length && (
            <p className="px-4 py-8 text-center text-sm text-white/50">No hay ventas para los filtros seleccionados.</p>
          )}
        </div>
      </section>

      <section className="rounded-2xl border p-4" aria-labelledby="cash-title">
        <DashboardSectionHeader
          id="cash-title"
          eyebrow="Histórico"
          title="Resultado acumulado"
          description={`Corte ${new Intl.DateTimeFormat("es-AR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Argentina/Buenos_Aires" }).format(new Date(financialSummary.generatedAt))} · ${financialSummary.ordersScanned} pedidos web · ${financialSummary.externalRowsScanned} externas · ${financialSummary.marketplaceRowsScanned} ML`}
          action={<span className="admin-dash-note">No responde a los filtros de arriba</span>}
        />

        <div className="space-y-4">
          <MetricGroup title="Ventas y cobros">
            <FinancialMetric label="Ventas brutas" value={maskAmount(financialSummary.grossSales, hidden)} detail="Web + externas + Mercado Libre" />
            <FinancialMetric label="Descuentos" value={maskAmount(financialSummary.transferDiscounts, hidden)} detail="Por transferencia" />
            <FinancialMetric label="Reintegrado" value={maskAmount(financialSummary.completedRefunds, hidden)} detail="Web, ML y externas dañadas" tone={financialSummary.completedRefunds > 0 ? "danger" : "neutral"} help="Reintegros y notas de crédito web (el reintegro cuenta aunque la NC siga pendiente), anulaciones de Mercado Libre y devoluciones externas con mercadería dañada." />
            <FinancialMetric label="Ventas netas" value={maskAmount(financialSummary.netSales, hidden)} detail="Luego de reintegros, comisiones y envíos" tone="positive" help="Ventas brutas menos reintegros, comisiones, logística absorbida y otros gastos directos, igual en los tres canales. En Mercado Libre es el Total liquidado." />
            <FinancialMetric label="Cobros web" value={maskAmount(financialSummary.externalCollected, hidden)} detail="Cobrado por pasarelas" help="Lo cobrado por Mercado Pago o transferencia en pedidos web pagos, sin el saldo interno aplicado." />
            <FinancialMetric label="Saldo aplicado" value={maskAmount(financialSummary.customerCreditUsed, hidden)} detail="Saldo interno usado" help="Saldo a favor de clientes usado como medio de pago en pedidos web." />
            <FinancialMetric label="Reintegro pendiente" value={maskAmount(financialSummary.pendingRefunds, hidden)} detail={`${pendingRefundOperations} ${pendingRefundOperations === 1 ? "operación" : "operaciones"}`} tone={financialSummary.pendingRefunds > 0 ? "warning" : "neutral"} help="Dinero que todavía hay que devolver a clientes." />
          </MetricGroup>

          <MetricGroup title="Envíos, comisiones y facturación">
            <FinancialMetric label="Envíos cobrados" value={maskAmount(financialSummary.shippingCharged, hidden)} detail="Cobrado al cliente" />
            <FinancialMetric label="Costo logístico" value={maskAmount(financialSummary.shippingCost, hidden)} detail="Web + externas + Mercado Libre" tone={financialSummary.shippingCost > 0 ? "warning" : "neutral"} />
            <FinancialMetric label="Resultado envíos web" value={maskAmount(financialSummary.shippingBalance, hidden)} detail="Cobrado menos costo web" tone={financialSummary.shippingBalance >= 0 ? "positive" : "danger"} help="Envíos cobrados a clientes web menos la tarifa de Andreani cotizada en cada pedido." />
            <FinancialMetric label="Comisiones" value={maskAmount(financialSummary.salesFees, hidden)} detail="Mercado Pago, ML y externas" tone={financialSummary.salesFees > 0 ? "warning" : "neutral"} />
            <FinancialMetric label="Otros directos" value={maskAmount(financialSummary.otherDirectCosts, hidden)} detail="Externas y ajustes ML" help="Otros gastos de ventas externas y conceptos del Total de Mercado Libre (ingresos por envío, bonificaciones). Negativo = a favor." />
            <FinancialMetric label="Ventas con factura" value={maskAmount(financialSummary.invoicedAmount, hidden)} detail={`${financialSummary.invoicedOrders} pedidos web`} help="Total de pedidos web con factura ARCA autorizada. No es el neto fiscal: no descuenta notas de crédito." />
            <FinancialMetric label="Cobertura ARCA" value={`${invoiceCoverage.toFixed(1).replace(".", ",")}%`} detail={`${financialSummary.ordersWithoutInvoice} pedidos sin factura`} tone={financialSummary.ordersWithoutInvoice > 0 ? "warning" : "positive"} help="Pedidos web pagos con factura autorizada sobre el total de pedidos web pagos." />
          </MetricGroup>

          <MetricGroup title="Costos y resultado">
            <FinancialMetric label="Compras mercadería" value={maskAmount(financialSummary.inventoryPurchases, hidden)} detail="Capital comprado" />
            <FinancialMetric label="Costo vendido" value={maskAmount(financialSummary.costOfGoodsSold, hidden)} detail={describeCostCoverage(financialSummary.costCoveragePercent, financialSummary.inferredCostPercent, financialSummary.complete)} help="Costo histórico de la mercadería vendida o perdida en devoluciones. El costo inferido sale de la ganancia declarada en ventas externas históricas y no es un costo de compra." />
            <FinancialMetric label="Resultado comercial" value={financialSummary.contributionResult == null ? "Pendiente" : maskAmount(financialSummary.contributionResult, hidden)} detail="Ventas netas − costo mercadería" tone={financialSummary.contributionResult == null ? "warning" : financialSummary.contributionResult >= 0 ? "positive" : "danger"} help="Resultado de las ventas antes de gastos generales. Pendiente mientras haya ventas sin costo." />
            <FinancialMetric label="Gastos pagados" value={maskAmount(financialSummary.operatingExpensesPaid, hidden)} detail="Gastos registrados" tone={financialSummary.operatingExpensesPaid > 0 ? "warning" : "neutral"} help="Sólo los gastos cargados en el sistema y pagados, más el costo de mercadería entregada como gasto." />
            <FinancialMetric label="Gastos pendientes" value={maskAmount(financialSummary.operatingExpensesPending, hidden)} detail="No se restan del resultado" tone={financialSummary.operatingExpensesPending > 0 ? "danger" : "neutral"} />
            <FinancialMetric label="Ganancia limpia" value={financialSummary.operatingResult == null ? "Pendiente" : maskAmount(financialSummary.operatingResult, hidden)} detail="Con gastos registrados" tone={financialSummary.operatingResult == null ? "warning" : financialSummary.operatingResult >= 0 ? "positive" : "danger"} help="Ganancia después de costos y gastos registrados." />
            <FinancialMetric label="Margen estimado" value={financialSummary.operatingMarginPercent == null ? "Pendiente" : hidden ? "****" : formatPercent(financialSummary.operatingMarginPercent)} detail="Ganancia limpia / facturación" tone={financialSummary.operatingMarginPercent == null ? "warning" : financialSummary.operatingMarginPercent >= 0 ? "positive" : "danger"} />
          </MetricGroup>
        </div>

        {financialSummary.warnings.length > 0 && (
          <ul className="mt-4 grid gap-2 lg:grid-cols-2">
            {financialSummary.warnings.map((warning) => (
              <li key={warning} className="admin-dash-warning">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <span>{warning}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function MetricGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-2 text-11px font-black uppercase tracking-widest text-white/55">{title}</h3>
      <div className="admin-dash-metric-grid">{children}</div>
    </div>
  )
}
