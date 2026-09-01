"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import dynamic from "next/dynamic"
import { useRouter, useSearchParams } from "next/navigation"
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  CheckCircle2,
  Clock,
  CreditCard,
  Download,
  Eye,
  EyeOff,
  FileUp,
  ImageDown,
  Package,
  ReceiptText,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldAlert,
  ShoppingCart,
  Store,
  Tags,
  UserRound,
  X,
} from "lucide-react"

import {
  type DashboardSearchItem,
  type DashboardSystemStatus,
  type DashboardCommercialSale,
  type DashboardRecentActivity,
} from "@/lib/supabase/queries/dashboard"
import { useDashboard } from "@/hooks/use-dashboard"
import { formatPrice } from "../productos/helpers"
import { useSiteSettings } from "@/hooks/use-site-settings"
import { AdminDatePicker } from "../../components/admin-date-picker"
import {
  AdminEmptyState,
  AdminSelect,
  AdminSkeleton,
  AdminStatCard,
} from "../../components/admin-controls"
import {
  ADMIN_ROUTES,
  type AdminRouteKey,
} from "@/lib/admin/admin-routes"
import { useAdminNotificationGroups } from "@/context/admin-notifications-context"

function DashboardPanelLoading() {
  return (
    <section
      aria-busy="true"
      aria-label="Cargando panel"
      className="rounded-3xl border border-beyonix-blue-light/16 bg-black/20 p-5"
    >
      <AdminSkeleton rows={4} />
    </section>
  )
}

const AdminCostsPanel = dynamic(
  () => import("./admin-costs-panel").then((module) => module.AdminCostsPanel),
  { loading: DashboardPanelLoading, ssr: false },
)
const AdminSalesLedger = dynamic(
  () => import("./admin-sales-ledger").then((module) => module.AdminSalesLedger),
  { loading: DashboardPanelLoading, ssr: false },
)
const AdminMercadoLibreSales = dynamic(
  () =>
    import("./admin-mercadolibre-sales").then(
      (module) => module.AdminMercadoLibreSales,
    ),
  { loading: DashboardPanelLoading, ssr: false },
)

type DashboardTab = "operativo" | "comercial" | "externas" | "ml" | "costos"
type SalesChannel =
  | "todos"
  | "BEYONIX Web"
  | "MercadoLibre Marketplace"
  | "Ventas externas"
type SortKey =
  | "productName"
  | "channel"
  | "paymentMethod"
  | "quantity"
  | "grossAmount"
  | "costAmount"
  | "profitAmount"
  | "marginPercent"
  | "ticket"

const HIDDEN_AMOUNT = "$******"
const MONTHS = [
  { value: "", label: "Todos" },
  { value: "0", label: "Enero" },
  { value: "1", label: "Febrero" },
  { value: "2", label: "Marzo" },
  { value: "3", label: "Abril" },
  { value: "4", label: "Mayo" },
  { value: "5", label: "Junio" },
  { value: "6", label: "Julio" },
  { value: "7", label: "Agosto" },
  { value: "8", label: "Septiembre" },
  { value: "9", label: "Octubre" },
  { value: "10", label: "Noviembre" },
  { value: "11", label: "Diciembre" },
]

function formatDate(value: string) {
  return new Intl.DateTimeFormat("es-AR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Argentina/Buenos_Aires",
  }).format(new Date(value))
}

function formatRelativeTime(value: string) {
  const date = new Date(value)
  const diffMs = Date.now() - date.getTime()
  const diffMinutes = Math.max(0, Math.floor(diffMs / 60000))

  if (diffMinutes < 1) return "Recién"
  if (diffMinutes < 60) return `Hace ${diffMinutes} min`

  const diffHours = Math.floor(diffMinutes / 60)
  if (diffHours < 24) return `Hace ${diffHours} h`

  const diffDays = Math.floor(diffHours / 24)
  if (diffDays < 7) return `Hace ${diffDays} d`

  return formatDate(value)
}

function isSameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

function matchesMetricMonth(date: Date, selectedMonth: string, selectedYear: string, today: Date) {
  const metricMonth = selectedMonth ? Number(selectedMonth) : today.getMonth()
  const metricYear = selectedYear ? Number(selectedYear) : today.getFullYear()

  return date.getMonth() === metricMonth && date.getFullYear() === metricYear
}

function matchesMetricYear(date: Date, selectedYear: string, today: Date) {
  const metricYear = selectedYear ? Number(selectedYear) : today.getFullYear()

  return date.getFullYear() === metricYear
}

function maskAmount(value: string, hidden: boolean) {
  return hidden ? HIDDEN_AMOUNT : value
}

function SectionHeader({
  eyebrow,
  title,
  action,
}: {
  eyebrow?: string
  title: string
  action?: React.ReactNode
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
      <div>
        {eyebrow && (
          <p className="mb-1 text-11px font-bold uppercase tracking-widest text-beyonix-cyan">
            {eyebrow}
          </p>
        )}
        <h2 className="text-xl font-black text-white">{title}</h2>
      </div>
      {action}
    </div>
  )
}

function FilterField({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="block min-w-0">
      <span className="mb-1.5 block text-center text-10px font-black uppercase tracking-widest text-white/42">
        {label}
      </span>
      {children}
    </div>
  )
}

function StatCard({
  title,
  value,
  helper,
  icon,
  onClick,
}: {
  title: string
  value: string | number
  helper?: string
  icon: React.ReactNode
  onClick?: () => void
}) {
  return (
    <AdminStatCard
      className="admin-dashboard-stat-card"
      title={title}
      value={value}
      helper={helper}
      icon={icon}
      onClick={onClick}
      action={
        onClick ? (
          <span className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-beyonix-blue-light/20 bg-black/18 px-2.5 text-11px font-black text-white/72 transition group-hover:border-beyonix-sky/38 group-hover:text-white">
            Abrir <ArrowRight className="size-3.5" />
          </span>
        ) : null
      }
    />
  )
}

function FinancialMetric({
  label,
  value,
  detail,
  tone = "neutral",
}: {
  label: string
  value: string
  detail: string
  tone?: "neutral" | "positive" | "warning" | "danger"
}) {
  const toneClass = {
    neutral: "text-white",
    positive: "text-emerald-300",
    warning: "text-amber-200",
    danger: "text-red-300",
  }[tone]

  return (
    <div className="admin-dashboard-financial-metric min-w-0 rounded-xl border border-beyonix-blue-light/14 bg-[rgba(3,7,13,0.72)] px-3 py-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.025)]">
      <p className="text-10px font-black uppercase tracking-widest text-white/42">
        {label}
      </p>
      <p className={`mt-1 truncate text-base font-black tabular-nums ${toneClass}`}>
        {value}
      </p>
      <p className="mt-1 truncate text-11px font-semibold text-white/42">
        {detail}
      </p>
    </div>
  )
}

function ControlIndicator({
  label,
  value,
  healthy,
  onClick,
}: {
  label: string
  value: number
  healthy: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex min-w-0 cursor-pointer items-center justify-between gap-3 rounded-xl border px-3 py-2.5 text-left transition ${
        healthy
          ? "border-emerald-400/16 bg-emerald-400/6 hover:border-emerald-400/30"
          : "border-red-400/22 bg-red-400/8 hover:border-red-400/40"
      }`}
    >
      <span className="truncate text-xs font-bold text-white/70">{label}</span>
      <span
        className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-black tabular-nums ${
          healthy
            ? "bg-emerald-400/12 text-emerald-300"
            : "bg-red-400/12 text-red-300"
        }`}
      >
        {value}
      </span>
    </button>
  )
}

function EmptyState({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode
  title: string
  description: string
}) {
  return (
    <AdminEmptyState icon={icon} title={title} description={description} />
  )
}

function ActivityIcon({ type }: { type: DashboardRecentActivity["type"] }) {
  const className = "size-4"

  if (type === "venta") return <ShoppingCart className={className} />
  if (type === "pago") return <CheckCircle2 className={className} />
  if (type === "despacho") return <Package className={className} />

  return <Clock className={className} />
}

function ActivityItem({ item }: { item: DashboardRecentActivity }) {
  const tone =
    item.type === "pago"
        ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-200"
        : item.type === "venta"
          ? "border-beyonix-sky/30 bg-beyonix-blue text-beyonix-sky"
          : item.type === "despacho"
            ? "border-amber-400/25 bg-amber-400/10 text-amber-200"
          : "border-white/10 bg-[#181818] text-white/70"

  return (
    <div className="rounded-2xl border border-beyonix-blue-light/14 bg-[rgba(3,7,13,0.72)] px-4 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.025)]">
      <div className="flex min-w-0 items-start gap-3">
        <span className={`mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl border ${tone}`}>
          <ActivityIcon type={item.type} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <p className="truncate text-sm font-black text-white">{item.title}</p>
              <p className="mt-1 truncate text-xs font-medium text-white/58">
                {item.detail}
              </p>
            </div>
            <span className="shrink-0 text-11px font-bold uppercase tracking-wide text-white/35">
              {formatRelativeTime(item.created_at)}
            </span>
          </div>
          {(item.meta || item.secondary) && (
            <div className="mt-3 flex flex-wrap gap-2">
              {item.meta && (
                <span className="rounded-full border border-beyonix-blue-light/14 bg-beyonix-blue/12 px-2.5 py-1 text-11px font-bold text-white/58">
                  {item.meta}
                </span>
              )}
              {item.secondary && (
                <span className="rounded-full border border-white/8 bg-black/24 px-2.5 py-1 text-11px font-bold text-white/45">
                  {item.secondary}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function normalizeSearch(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
}

function searchScore(row: DashboardSearchItem, normalizedQuery: string) {
  const title = normalizeSearch(row.title)
  const detail = normalizeSearch(row.detail)
  const haystack = normalizeSearch(`${row.title} ${row.detail} ${row.keywords}`)
  const tokens = normalizedQuery.split(/\s+/).filter(Boolean)
  if (!tokens.every((token) => haystack.includes(token))) return -1

  let score = 0
  if (title === normalizedQuery) score += 100
  if (title.startsWith(normalizedQuery)) score += 60
  if (title.includes(normalizedQuery)) score += 35
  if (detail.startsWith(normalizedQuery)) score += 20
  if (row.type === "pedido" && row.keywords.split(/\s+/).includes(normalizedQuery)) {
    score += 45
  }
  score += Math.max(0, 12 - title.length / 10)
  return score
}

function GlobalAdminSearch({
  rows,
  onNavigate,
}: {
  rows: DashboardSearchItem[]
  onNavigate: (section: AdminRouteKey) => void
}) {
  const [query, setQuery] = useState("")
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const results = useMemo(() => {
    const normalized = normalizeSearch(query.trim())
    if (normalized.length < 2) return []

    return rows
      .map((row) => ({ row, score: searchScore(row, normalized) }))
      .filter((result) => result.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map((result) => result.row)
  }, [query, rows])

  useEffect(() => {
    setActiveIndex(0)
  }, [query])

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault()
        inputRef.current?.focus()
        setOpen(true)
      }
    }
    const handleOutsideClick = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }

    document.addEventListener("keydown", handleShortcut)
    document.addEventListener("mousedown", handleOutsideClick)
    return () => {
      document.removeEventListener("keydown", handleShortcut)
      document.removeEventListener("mousedown", handleOutsideClick)
    }
  }, [])

  const chooseResult = (row: DashboardSearchItem) => {
    setQuery("")
    setOpen(false)
    onNavigate(row.section)
  }

  const showResults = open && query.trim().length >= 2

  return (
    <div ref={rootRef} className="relative w-full max-w-2xl">
      <div
        className={`admin-dashboard-search flex h-12 items-center gap-3 rounded-2xl border bg-[linear-gradient(135deg,rgba(9,23,36,0.94),rgba(3,8,14,0.96))] px-3 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.045)] transition ${
          open
            ? "border-beyonix-sky/55 shadow-[0_0_24px_rgba(56,189,248,0.1)]"
            : "border-beyonix-blue-light/22 hover:border-beyonix-sky/36"
        }`}
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-xl border border-beyonix-sky/18 bg-beyonix-blue/25 text-beyonix-sky">
          <Search className="size-4" />
        </span>
        <input
          ref={inputRef}
          type="search"
          role="combobox"
          aria-label="Buscar en el panel administrativo"
          aria-expanded={showResults}
          aria-controls="dashboard-search-results"
          aria-autocomplete="list"
          aria-activedescendant={
            results[activeIndex]
              ? `dashboard-search-option-${results[activeIndex].id}`
              : undefined
          }
          autoComplete="off"
          value={query}
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            setQuery(event.target.value)
            setOpen(true)
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" && results.length) {
              event.preventDefault()
              setActiveIndex((current) => (current + 1) % results.length)
            } else if (event.key === "ArrowUp" && results.length) {
              event.preventDefault()
              setActiveIndex(
                (current) => (current - 1 + results.length) % results.length,
              )
            } else if (event.key === "Enter" && results[activeIndex]) {
              event.preventDefault()
              chooseResult(results[activeIndex])
            } else if (event.key === "Escape") {
              setOpen(false)
              inputRef.current?.blur()
            }
          }}
          placeholder="Buscar pedido, cliente, producto o SKU..."
          className="admin-dashboard-search-input min-w-0 flex-1 text-sm font-semibold text-white outline-none placeholder:text-white/35"
        />
        {query ? (
          <button
            type="button"
            aria-label="Limpiar búsqueda"
            title="Limpiar búsqueda"
            onClick={() => {
              setQuery("")
              inputRef.current?.focus()
            }}
            className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-white/38 transition hover:bg-white/7 hover:text-white"
          >
            <X className="size-4" />
          </button>
        ) : (
          <kbd className="hidden shrink-0 rounded-lg border border-white/9 bg-black/28 px-2 py-1 text-10px font-black text-white/38 sm:inline-flex">
            Ctrl K
          </kbd>
        )}
      </div>
      {showResults && (
        <div
          id="dashboard-search-results"
          role="listbox"
          aria-label="Resultados de búsqueda"
          className="absolute left-0 right-0 top-full z-40 mt-2 overflow-hidden rounded-2xl border border-beyonix-sky/24 bg-[#071018]/98 shadow-2xl shadow-black/65 backdrop-blur-xl"
        >
          {results.length ? (
            <>
              <div className="flex items-center justify-between border-b border-white/7 px-4 py-2.5">
                <span className="text-10px font-black uppercase tracking-widest text-white/35">
                  {results.length} {results.length === 1 ? "resultado" : "resultados"}
                </span>
                <span className="text-10px font-semibold text-white/28">
                  ↑↓ navegar · Enter abrir
                </span>
              </div>
              {results.map((row, index) => (
                <button
                  key={row.id}
                  id={`dashboard-search-option-${row.id}`}
                  type="button"
                  role="option"
                  aria-selected={activeIndex === index}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => chooseResult(row)}
                  className={`flex w-full cursor-pointer items-center gap-3 border-b border-white/6 px-3 py-3 text-left transition last:border-b-0 ${
                    activeIndex === index
                      ? "bg-beyonix-blue/32"
                      : "hover:bg-beyonix-blue/20"
                  }`}
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-beyonix-sky/16 bg-beyonix-blue/20 text-beyonix-sky">
                    {row.type === "pedido" ? (
                      <ShoppingCart className="size-4" />
                    ) : row.type === "cliente" ? (
                      <UserRound className="size-4" />
                    ) : (
                      <Package className="size-4" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-black text-white">
                      {row.title}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-white/48">
                      {row.detail}
                    </span>
                  </span>
                  <span className="shrink-0 rounded-full border border-white/8 bg-black/32 px-2.5 py-1 text-10px font-black uppercase tracking-widest text-white/42">
                    {row.type}
                  </span>
                  <ArrowRight
                    className={`size-3.5 shrink-0 text-beyonix-sky transition ${
                      activeIndex === index ? "translate-x-0" : "-translate-x-1 opacity-0"
                    }`}
                  />
                </button>
              ))}
            </>
          ) : (
            <div className="px-4 py-5 text-center">
              <p className="text-sm font-black text-white/62">
                No encontramos coincidencias
              </p>
              <p className="mt-1 text-xs text-white/38">
                Probá con otro nombre, número de pedido, DNI o producto.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function SystemStatusPill({
  item,
  ready,
}: {
  item: DashboardSystemStatus
  ready: boolean
}) {
  const effectiveStatus = ready ? item.status : "unknown"
  const tone =
    effectiveStatus === "ok"
      ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-200"
      : effectiveStatus === "error"
        ? "border-red-400/25 bg-red-400/10 text-red-200"
        : effectiveStatus === "warning"
          ? "border-amber-400/25 bg-amber-400/10 text-amber-200"
          : effectiveStatus === "disabled"
            ? "border-slate-400/20 bg-slate-400/8 text-slate-300"
          : "border-white/10 bg-white/5 text-white/52"
  const label =
    !ready
      ? "Verificando"
      : item.verified === false
        ? "No verificable"
        : item.status === "ok"
          ? "Operativo"
          : item.status === "error"
            ? "Caído"
            : item.status === "warning"
              ? "Degradado"
              : item.status === "disabled"
                ? "Deshabilitado"
                : "Sin verificar"

  return (
    <div className="rounded-xl border border-beyonix-blue-light/14 bg-[rgba(3,7,13,0.72)] px-3 py-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.025)]">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-black text-white">{item.label}</p>
          <p className="mt-1 line-clamp-2 text-11px leading-4 text-white/45">
            {ready ? item.detail : "Ejecutando una comprobación real..."}
          </p>
          {ready && item.checkedAt && (
            <p className="mt-1 text-9px font-bold uppercase tracking-wide text-white/28">
              {item.latencyMs != null ? `${item.latencyMs} ms · ` : ""}
              {formatRelativeTime(item.checkedAt)}
            </p>
          )}
        </div>
        <span className={`shrink-0 rounded-full border px-2 py-0.5 text-9px font-black uppercase tracking-widest ${tone}`}>
          {label}
        </span>
      </div>
    </div>
  )
}

function Skeleton() {
  return <AdminSkeleton rows={7} className="p-4 sm:p-6 lg:p-8" />
}

type EvolutionGrouping = "month" | "day"
type EvolutionMode = "evolution" | "comparison"

interface EvolutionPoint {
  key: string
  label: string
  value: number | null
}

interface EvolutionComparisonRange {
  id: number
  from: string
  to: string
  color: string
}

interface EvolutionChartSeries {
  id: string | number
  label: string
  color: string
  from: string
  to: string
  points: EvolutionPoint[]
  total: number
  averageDaily: number
}

function formatEvolutionPeriod(key: string, grouping: EvolutionGrouping) {
  const [year, month, day] = key.split("-").map(Number)
  const date = new Date(year, Math.max(0, month - 1), day || 1)

  return new Intl.DateTimeFormat("es-AR", {
    month: "short",
    ...(grouping === "day" ? { day: "2-digit" as const } : {}),
    ...(grouping === "month" ? { year: "2-digit" as const } : {}),
  })
    .format(date)
    .replace(".", "")
}

function groupEvolutionSales(
  rows: DashboardCommercialSale[],
  grouping: EvolutionGrouping,
) {
  const totals = new Map<string, number>()

  rows.forEach((row) => {
    const dateKey = row.date.slice(0, 10)
    const key = grouping === "month" ? dateKey.slice(0, 7) : dateKey

    if (!/^\d{4}-\d{2}(?:-\d{2})?$/.test(key)) return

    totals.set(key, (totals.get(key) ?? 0) + row.grossAmount)
  })

  return [...totals.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map<EvolutionPoint>(([key, value]) => ({
      key,
      label: formatEvolutionPeriod(key, grouping),
      value,
    }))
}

function getEvolutionPeriodKeys(
  from: string,
  to: string,
  grouping: EvolutionGrouping,
) {
  if (!from || !to || from > to) return []

  if (grouping === "month") {
    const [fromYear, fromMonth] = from.split("-").map(Number)
    const [toYear, toMonth] = to.split("-").map(Number)

    if (!fromYear || !fromMonth || !toYear || !toMonth) return []

    const keys: string[] = []
    let year = fromYear
    let month = fromMonth

    while (year < toYear || (year === toYear && month <= toMonth)) {
      keys.push(`${year}-${String(month).padStart(2, "0")}`)
      month += 1

      if (month > 12) {
        month = 1
        year += 1
      }
    }

    return keys
  }

  const keys: string[] = []
  const cursor = new Date(`${from}T00:00:00Z`)
  const lastDate = new Date(`${to}T00:00:00Z`)

  if (Number.isNaN(cursor.getTime()) || Number.isNaN(lastDate.getTime())) {
    return []
  }

  while (cursor <= lastDate) {
    keys.push(cursor.toISOString().slice(0, 10))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }

  return keys
}

function alignEvolutionPeriods(
  points: EvolutionPoint[],
  periodKeys: string[],
  from: string,
  to: string,
  grouping: EvolutionGrouping,
) {
  const values = new Map(points.map((point) => [point.key, point.value]))

  return periodKeys.map<EvolutionPoint>((key) => ({
    key,
    label: formatEvolutionPeriod(key, grouping),
    value: key >= from && key <= to ? (values.get(key) ?? 0) : null,
  }))
}

function alignRelativeEvolutionPeriods(
  points: EvolutionPoint[],
  from: string,
  to: string,
  length: number,
) {
  const periodKeys = getEvolutionPeriodKeys(from, to, "day")
  const values = new Map(points.map((point) => [point.key, point.value]))

  return Array.from({ length }, (_, index): EvolutionPoint => {
    const key = periodKeys[index]

    return key
      ? {
          key,
          label: formatEvolutionPeriod(key, "day"),
          value: values.get(key) ?? 0,
        }
      : {
          key: `relative-${index + 1}`,
          label: `Día ${index + 1}`,
          value: null,
        }
  })
}

function formatEvolutionTooltipDate(key: string) {
  if (/^\d{4}-\d{2}$/.test(key)) {
    const [year, month] = key.split("-").map(Number)

    return new Intl.DateTimeFormat("es-AR", {
      month: "long",
      year: "numeric",
    }).format(new Date(year, month - 1, 1))
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return key

  const [year, month, day] = key.split("-").map(Number)

  return new Intl.DateTimeFormat("es-AR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  })
    .format(new Date(year, month - 1, day))
    .replace(".", "")
}

interface HsvColor {
  h: number
  s: number
  v: number
}

function normalizeHexColor(value: string) {
  const trimmed = value.trim().replace(/^#/, "")
  const expanded =
    trimmed.length === 3
      ? trimmed
          .split("")
          .map((character) => `${character}${character}`)
          .join("")
      : trimmed

  return /^[\da-f]{6}$/i.test(expanded) ? `#${expanded.toUpperCase()}` : null
}

function hexToHsv(value: string): HsvColor {
  const normalized = normalizeHexColor(value) ?? "#38BDF8"
  const red = Number.parseInt(normalized.slice(1, 3), 16) / 255
  const green = Number.parseInt(normalized.slice(3, 5), 16) / 255
  const blue = Number.parseInt(normalized.slice(5, 7), 16) / 255
  const maximum = Math.max(red, green, blue)
  const minimum = Math.min(red, green, blue)
  const delta = maximum - minimum
  let hue = 0

  if (delta !== 0) {
    if (maximum === red) hue = 60 * (((green - blue) / delta) % 6)
    else if (maximum === green) hue = 60 * ((blue - red) / delta + 2)
    else hue = 60 * ((red - green) / delta + 4)
  }

  if (hue < 0) hue += 360

  return {
    h: hue,
    s: maximum === 0 ? 0 : (delta / maximum) * 100,
    v: maximum * 100,
  }
}

function hsvToHex({ h, s, v }: HsvColor) {
  const saturation = Math.max(0, Math.min(100, s)) / 100
  const brightness = Math.max(0, Math.min(100, v)) / 100
  const chroma = brightness * saturation
  const hueSection = ((h % 360) + 360) % 360 / 60
  const secondary = chroma * (1 - Math.abs((hueSection % 2) - 1))
  const offset = brightness - chroma
  let channels = [0, 0, 0]

  if (hueSection < 1) channels = [chroma, secondary, 0]
  else if (hueSection < 2) channels = [secondary, chroma, 0]
  else if (hueSection < 3) channels = [0, chroma, secondary]
  else if (hueSection < 4) channels = [0, secondary, chroma]
  else if (hueSection < 5) channels = [secondary, 0, chroma]
  else channels = [chroma, 0, secondary]

  return `#${channels
    .map((channel) =>
      Math.round((channel + offset) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")
    .toUpperCase()}`
}

function getDarkBackgroundContrast(value: string) {
  const normalized = normalizeHexColor(value) ?? "#000000"
  const channels = [1, 3, 5].map((start) => {
    const channel = Number.parseInt(normalized.slice(start, start + 2), 16) / 255
    return channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4
  })
  const foreground =
    channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
  const background = 0.004

  return (foreground + 0.05) / (background + 0.05)
}

function EvolutionColorPicker({
  value,
  label,
  defaultColor,
  onChange,
}: {
  value: string
  label: string
  defaultColor?: string
  disabledColors?: string[]
  onChange: (value: string) => void
}) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [hsv, setHsv] = useState(() => hexToHsv(value))
  const [hexInput, setHexInput] = useState(
    () => normalizeHexColor(value) ?? "#38BDF8",
  )
  const [position, setPosition] = useState({ left: 8, top: 8, width: 320 })
  const normalizedValue = normalizeHexColor(value) ?? "#38BDF8"
  const restoredColor =
    normalizeHexColor(defaultColor ?? "") ??
    (label.toLocaleLowerCase("es").includes("segunda")
      ? "#A78BFA"
      : "#38BDF8")
  const lowContrast = getDarkBackgroundContrast(normalizedValue) < 2.2

  useEffect(() => {
    const normalized = normalizeHexColor(value)
    if (!normalized) return
    setHsv(hexToHsv(normalized))
    setHexInput(normalized)
  }, [value])

  useEffect(() => {
    if (!open) return

    const updatePosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return

      const width = Math.min(320, window.innerWidth - 16)
      const estimatedHeight = 356
      const left = Math.min(
        Math.max(8, rect.left),
        Math.max(8, window.innerWidth - width - 8),
      )
      const openAbove =
        window.innerHeight - rect.bottom < estimatedHeight &&
        rect.top > estimatedHeight

      setPosition({
        left,
        top: openAbove
          ? Math.max(8, rect.top - estimatedHeight - 6)
          : Math.min(
              Math.max(8, rect.bottom + 6),
              window.innerHeight - estimatedHeight - 8,
            ),
        width,
      })
    }
    const closeOutside = (event: MouseEvent) => {
      const target = event.target as Node
      if (
        !triggerRef.current?.contains(target) &&
        !popoverRef.current?.contains(target)
      ) {
        setOpen(false)
      }
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }

    updatePosition()
    document.addEventListener("mousedown", closeOutside)
    document.addEventListener("keydown", closeOnEscape)
    window.addEventListener("resize", updatePosition)
    window.addEventListener("scroll", updatePosition, true)

    return () => {
      document.removeEventListener("mousedown", closeOutside)
      document.removeEventListener("keydown", closeOnEscape)
      window.removeEventListener("resize", updatePosition)
      window.removeEventListener("scroll", updatePosition, true)
    }
  }, [open])

  const commitHsv = (next: HsvColor) => {
    const normalized = {
      h: Math.max(0, Math.min(359, next.h)),
      s: Math.max(0, Math.min(100, next.s)),
      v: Math.max(0, Math.min(100, next.v)),
    }
    const hex = hsvToHex(normalized)
    setHsv(normalized)
    setHexInput(hex)
    onChange(hex)
  }
  const updateSaturationAndBrightness = (
    clientX: number,
    clientY: number,
    element: HTMLElement,
  ) => {
    const rect = element.getBoundingClientRect()
    commitHsv({
      ...hsv,
      s: ((clientX - rect.left) / rect.width) * 100,
      v: 100 - ((clientY - rect.top) / rect.height) * 100,
    })
  }

  return (
    <div>
      <p className="mb-1.5 text-10px font-black uppercase tracking-widest text-white/38">
        {label}
      </p>
      <button
        ref={triggerRef}
        type="button"
        aria-label={`Cambiar color del período. Color actual ${normalizedValue}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Cambiar color del período"
        onClick={() => setOpen((current) => !current)}
        className="flex h-11 min-w-[118px] cursor-pointer items-center gap-2 rounded-xl border border-white/10 bg-black/25 px-2.5 text-11px font-black text-white/72 outline-none transition hover:border-white/20 focus-visible:ring-2 focus-visible:ring-beyonix-sky/65"
      >
        <span
          className="size-6 shrink-0 rounded-lg border border-white/30 shadow-sm"
          style={{ backgroundColor: normalizedValue }}
        />
        <span className="font-mono">{normalizedValue}</span>
      </button>

      {open &&
        createPortal(
          <div
            ref={popoverRef}
            role="dialog"
            aria-label={`Cambiar color de ${label}`}
            className="admin-portal-scope fixed z-110 max-h-[calc(100vh-16px)] overflow-y-auto rounded-2xl border border-white/12 bg-[#0a111a] p-3 shadow-2xl shadow-black/70"
            style={position}
          >
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-black text-white">
                  Color del período
                </p>
                <p className="mt-0.5 text-10px text-white/42">
                  Saturación y luminosidad
                </p>
              </div>
              <button
                type="button"
                aria-label="Cerrar selector de color"
                onClick={() => {
                  setOpen(false)
                  triggerRef.current?.focus()
                }}
                className="flex size-8 cursor-pointer items-center justify-center rounded-lg text-white/45 outline-none transition hover:bg-white/8 hover:text-white focus-visible:ring-2 focus-visible:ring-beyonix-sky/65"
              >
                <X className="size-4" />
              </button>
            </div>

            <div
              role="slider"
              tabIndex={0}
              aria-label="Saturación y luminosidad"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(hsv.v)}
              aria-valuetext={`Saturación ${Math.round(hsv.s)}%, luminosidad ${Math.round(hsv.v)}%`}
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId)
                updateSaturationAndBrightness(
                  event.clientX,
                  event.clientY,
                  event.currentTarget,
                )
              }}
              onPointerMove={(event) => {
                if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
                  return
                }
                updateSaturationAndBrightness(
                  event.clientX,
                  event.clientY,
                  event.currentTarget,
                )
              }}
              onKeyDown={(event) => {
                const step = event.shiftKey ? 10 : 2
                if (event.key === "ArrowLeft") {
                  event.preventDefault()
                  commitHsv({ ...hsv, s: hsv.s - step })
                } else if (event.key === "ArrowRight") {
                  event.preventDefault()
                  commitHsv({ ...hsv, s: hsv.s + step })
                } else if (event.key === "ArrowUp") {
                  event.preventDefault()
                  commitHsv({ ...hsv, v: hsv.v + step })
                } else if (event.key === "ArrowDown") {
                  event.preventDefault()
                  commitHsv({ ...hsv, v: hsv.v - step })
                }
              }}
              className="relative h-36 cursor-crosshair touch-none overflow-hidden rounded-xl outline-none ring-offset-2 ring-offset-[#0a111a] focus-visible:ring-2 focus-visible:ring-beyonix-sky/70"
              style={{
                backgroundColor: hsvToHex({ h: hsv.h, s: 100, v: 100 }),
                backgroundImage:
                  "linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent)",
              }}
            >
              <span
                className="pointer-events-none absolute size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,.65)]"
                style={{ left: `${hsv.s}%`, top: `${100 - hsv.v}%` }}
              />
            </div>

            <label className="mt-3 block text-10px font-black uppercase tracking-widest text-white/40">
              Tono
              <input
                type="range"
                min="0"
                max="359"
                value={Math.round(hsv.h)}
                aria-label="Tono del color"
                onChange={(event) =>
                  commitHsv({ ...hsv, h: Number(event.target.value) })
                }
                className="mt-2 h-3 w-full cursor-pointer appearance-none rounded-full border border-white/10 bg-[linear-gradient(to_right,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)] outline-none focus-visible:ring-2 focus-visible:ring-beyonix-sky/70 [&::-moz-range-thumb]:size-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-white [&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white [&::-webkit-slider-thumb]:bg-transparent"
              />
            </label>

            <div className="mt-3 flex items-end gap-2">
              <span
                className="size-10 shrink-0 rounded-xl border border-white/20"
                style={{ backgroundColor: normalizedValue }}
                aria-label={`Vista previa ${normalizedValue}`}
              />
              <label className="min-w-0 flex-1 text-10px font-black uppercase tracking-widest text-white/40">
                HEX
                <input
                  value={hexInput}
                  maxLength={7}
                  spellCheck={false}
                  aria-invalid={!normalizeHexColor(hexInput)}
                  onChange={(event) => {
                    const next = event.target.value.toUpperCase()
                    setHexInput(next)
                    const normalized = normalizeHexColor(next)
                    if (normalized) {
                      setHsv(hexToHsv(normalized))
                      onChange(normalized)
                    }
                  }}
                  className={`mt-1 h-10 w-full rounded-xl border bg-black/30 px-3 font-mono text-xs font-bold text-white outline-none ${
                    normalizeHexColor(hexInput)
                      ? "border-white/10 focus:border-beyonix-sky/60"
                      : "border-red-400/50 focus:border-red-400"
                  }`}
                />
              </label>
              <button
                type="button"
                onClick={() => commitHsv(hexToHsv(restoredColor))}
                className="inline-flex h-10 cursor-pointer items-center gap-1.5 rounded-xl border border-white/10 px-3 text-10px font-black text-white/52 outline-none transition hover:border-white/20 hover:text-white focus-visible:ring-2 focus-visible:ring-beyonix-sky/65"
              >
                <RotateCcw className="size-3.5" />
                Restaurar
              </button>
            </div>

            {!normalizeHexColor(hexInput) && (
              <p className="mt-2 text-10px font-semibold text-red-300">
                Ingresá un HEX válido, por ejemplo #38BDF8.
              </p>
            )}
            {lowContrast && (
              <p className="mt-2 rounded-lg border border-amber-400/15 bg-amber-400/7 px-2.5 py-2 text-10px font-semibold leading-4 text-amber-200/80">
                Este color tiene poco contraste sobre el fondo del gráfico.
              </p>
            )}
          </div>,
          document.body,
        )}
    </div>
  )
}

function formatEvolutionAxisAmount(value: number, hidden: boolean) {
  if (hidden) return "$••••"

  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value)
}

function getEvolutionTickIndexes(
  length: number,
  mode: EvolutionMode,
  grouping: EvolutionGrouping,
  maxLabels: number,
) {
  if (length <= 0) return []

  let step = 1

  if (mode === "comparison" || grouping === "day") {
    if (length <= 14) step = 1
    else if (length <= 60) step = 7
    else if (length <= 180) step = 14
    else if (length <= 730) step = 30
    else step = 365
  } else if (length <= 18) step = 1
  else if (length <= 60) step = 3
  else if (length <= 120) step = 6
  else step = 12

  step = Math.max(step, Math.ceil((length - 1) / Math.max(1, maxLabels - 1)))

  const indexes = Array.from(
    { length: Math.ceil(length / step) },
    (_, index) => index * step,
  ).filter((index) => index < length)

  if (indexes.at(-1) !== length - 1) indexes.push(length - 1)

  return indexes
}

function formatEvolutionAxisLabel(
  point: EvolutionPoint,
  mode: EvolutionMode,
  grouping: EvolutionGrouping,
  visiblePointCount: number,
  relativeDay: number,
) {
  if (mode === "comparison") return `Día ${relativeDay}`

  const [year, month, day] = point.key.split("-").map(Number)
  const date = new Date(year, Math.max(0, month - 1), day || 1)

  if (grouping === "month" || visiblePointCount > 180) {
    return new Intl.DateTimeFormat("es-AR", {
      month: visiblePointCount > 730 ? undefined : "short",
      year: "numeric",
    })
      .format(date)
      .replace(".", "")
  }

  return new Intl.DateTimeFormat("es-AR", {
    day: "2-digit",
    month: "short",
  })
    .format(date)
    .replace(".", "")
}

function TemporalBrush({
  value,
  label,
  disabled = false,
  onChange,
}: {
  value: { from: number; to: number }
  label: string
  disabled?: boolean
  onChange: (value: { from: number; to: number }) => void
}) {
  const trackRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{
    type: "start" | "end" | "move"
    clientX: number
    from: number
    to: number
  } | null>(null)
  const [dragging, setDragging] = useState<
    "start" | "end" | "move" | null
  >(null)

  useEffect(() => {
    if (!dragging) return

    const handlePointerMove = (event: PointerEvent) => {
      const initial = dragRef.current
      const width = trackRef.current?.getBoundingClientRect().width ?? 0
      if (!initial || width <= 0) return

      const delta = ((event.clientX - initial.clientX) / width) * 100

      if (initial.type === "start") {
        onChange({
          from: Math.max(0, Math.min(initial.to - 1, initial.from + delta)),
          to: initial.to,
        })
      } else if (initial.type === "end") {
        onChange({
          from: initial.from,
          to: Math.min(100, Math.max(initial.from + 1, initial.to + delta)),
        })
      } else {
        const rangeWidth = initial.to - initial.from
        const nextFrom = Math.max(
          0,
          Math.min(100 - rangeWidth, initial.from + delta),
        )
        onChange({ from: nextFrom, to: nextFrom + rangeWidth })
      }
    }
    const stopDragging = () => {
      dragRef.current = null
      setDragging(null)
    }

    window.addEventListener("pointermove", handlePointerMove)
    window.addEventListener("pointerup", stopDragging)
    window.addEventListener("pointercancel", stopDragging)

    return () => {
      window.removeEventListener("pointermove", handlePointerMove)
      window.removeEventListener("pointerup", stopDragging)
      window.removeEventListener("pointercancel", stopDragging)
    }
  }, [dragging, onChange])

  const startDragging = (
    type: "start" | "end" | "move",
    clientX: number,
  ) => {
    if (disabled) return
    dragRef.current = {
      type,
      clientX,
      from: value.from,
      to: value.to,
    }
    setDragging(type)
  }
  const moveWindowWithKeyboard = (direction: -1 | 1, large: boolean) => {
    const step = large ? 5 : 1
    const width = value.to - value.from
    const nextFrom = Math.max(
      0,
      Math.min(100 - width, value.from + direction * step),
    )
    onChange({ from: nextFrom, to: nextFrom + width })
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-10px font-black uppercase tracking-widest text-white/38">
          Navegador temporal
        </p>
        <p className="truncate text-11px font-semibold text-white/58">{label}</p>
      </div>
      <div
        ref={trackRef}
        role="group"
        aria-label="Zoom temporal"
        onPointerDown={(event) => {
          if (
            disabled ||
            event.target !== event.currentTarget ||
            !trackRef.current
          ) {
            return
          }

          const rect = trackRef.current.getBoundingClientRect()
          const click = ((event.clientX - rect.left) / rect.width) * 100
          const width = value.to - value.from
          const from = Math.max(0, Math.min(100 - width, click - width / 2))
          onChange({ from, to: from + width })
        }}
        className={`relative mt-3 h-12 touch-none rounded-xl border border-white/9 bg-[#070b10] px-2 ${
          disabled ? "opacity-40" : ""
        }`}
      >
        <div className="pointer-events-none absolute inset-x-3 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-white/7">
          <span
            className="absolute inset-y-0 rounded-full bg-white/18"
            style={{ left: `${value.from}%`, right: `${100 - value.to}%` }}
          />
        </div>

        <div
          role="slider"
          tabIndex={disabled ? -1 : 0}
          aria-label="Mover ventana temporal"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round((value.from + value.to) / 2)}
          aria-valuetext={label}
          onPointerDown={(event) => {
            event.stopPropagation()
            startDragging("move", event.clientX)
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
              event.preventDefault()
              moveWindowWithKeyboard(
                event.key === "ArrowLeft" ? -1 : 1,
                event.shiftKey,
              )
            }
          }}
          className={`absolute inset-y-2 rounded-lg border border-white/24 bg-white/8 outline-none transition focus-visible:ring-2 focus-visible:ring-beyonix-sky/65 ${
            dragging === "move"
              ? "cursor-grabbing bg-white/12"
              : "cursor-grab hover:bg-white/10"
          }`}
          style={{
            left: `calc(${value.from}% + 8px)`,
            right: `calc(${100 - value.to}% + 8px)`,
          }}
        >
          <span className="pointer-events-none absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 gap-1">
            <span className="h-3 w-px rounded-full bg-white/24" />
            <span className="h-3 w-px rounded-full bg-white/24" />
            <span className="h-3 w-px rounded-full bg-white/24" />
          </span>

          <button
            type="button"
            role="slider"
            aria-label="Ajustar inicio de la ventana temporal"
            aria-valuemin={0}
            aria-valuemax={Math.max(0, value.to - 1)}
            aria-valuenow={Math.round(value.from)}
            disabled={disabled}
            onPointerDown={(event) => {
              event.stopPropagation()
              startDragging("start", event.clientX)
            }}
            onKeyDown={(event) => {
              const step = event.shiftKey ? 5 : 1
              if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                event.preventDefault()
                onChange({
                  from: Math.max(
                    0,
                    Math.min(
                      value.to - 1,
                      value.from +
                        (event.key === "ArrowLeft" ? -step : step),
                    ),
                  ),
                  to: value.to,
                })
              }
            }}
            className={`absolute inset-y-0 left-0 w-4 -translate-x-1/2 cursor-ew-resize rounded-md border border-white/45 bg-[#141b23] outline-none transition hover:bg-[#202a35] focus-visible:ring-2 focus-visible:ring-beyonix-sky/75 ${
              dragging === "start" ? "bg-[#273341]" : ""
            }`}
          />
          <button
            type="button"
            role="slider"
            aria-label="Ajustar fin de la ventana temporal"
            aria-valuemin={Math.min(100, value.from + 1)}
            aria-valuemax={100}
            aria-valuenow={Math.round(value.to)}
            disabled={disabled}
            onPointerDown={(event) => {
              event.stopPropagation()
              startDragging("end", event.clientX)
            }}
            onKeyDown={(event) => {
              const step = event.shiftKey ? 5 : 1
              if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                event.preventDefault()
                onChange({
                  from: value.from,
                  to: Math.min(
                    100,
                    Math.max(
                      value.from + 1,
                      value.to +
                        (event.key === "ArrowLeft" ? -step : step),
                    ),
                  ),
                })
              }
            }}
            className={`absolute inset-y-0 right-0 w-4 translate-x-1/2 cursor-ew-resize rounded-md border border-white/45 bg-[#141b23] outline-none transition hover:bg-[#202a35] focus-visible:ring-2 focus-visible:ring-beyonix-sky/75 ${
              dragging === "end" ? "bg-[#273341]" : ""
            }`}
          />
        </div>
      </div>
      <p className="mt-2 text-10px leading-4 text-white/32">
        Arrastrá la ventana para explorar. Usá los bordes para acercar o alejar.
      </p>
    </div>
  )
}

function EnhancedMiniLineChart({
  rows,
  channelRows,
  hidden,
}: {
  rows: DashboardCommercialSale[]
  channelRows: { label: string; value: number; amount?: number }[]
  hidden: boolean
}) {
  const [mode, setMode] = useState<EvolutionMode>("evolution")
  const [grouping, setGrouping] = useState<EvolutionGrouping>("month")
  const [chartFrom, setChartFrom] = useState("")
  const [chartTo, setChartTo] = useState("")
  const [comparisonRange, setComparisonRange] =
    useState<EvolutionComparisonRange>({
      id: 1,
      from: "",
      to: "",
      color: "#a78bfa",
    })
  const [primaryColor, setPrimaryColor] = useState("#38bdf8")
  const [chartChannel, setChartChannel] = useState<SalesChannel>("todos")
  const [showAverage, setShowAverage] = useState(false)
  const [visibleRange, setVisibleRange] = useState({ from: 0, to: 100 })
  const [activePoint, setActivePoint] = useState<{
    index: number
    x: number
    y: number
    color: string
  } | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const chartViewportRef = useRef<HTMLDivElement>(null)
  const [chartViewportWidth, setChartViewportWidth] = useState(760)

  useEffect(() => {
    const element = chartViewportRef.current
    if (!element) return

    const updateWidth = () => setChartViewportWidth(element.clientWidth)
    if (typeof ResizeObserver === "undefined") {
      updateWidth()
      return
    }
    const observer = new ResizeObserver(updateWidth)
    updateWidth()
    observer.observe(element)

    return () => observer.disconnect()
  }, [])

  const availableChannels = useMemo(
    () => Array.from(new Set(rows.map((row) => row.channel))).sort(),
    [rows],
  )
  const chartRows = useMemo(
    () =>
      chartChannel === "todos"
        ? rows
        : rows.filter((row) => row.channel === chartChannel),
    [chartChannel, rows],
  )
  const availableBounds = useMemo(() => {
    const keys = chartRows
      .map((row) => row.date.slice(0, 10))
      .filter((key) => /^\d{4}-\d{2}-\d{2}$/.test(key))
      .sort()

    return { from: keys[0] ?? "", to: keys.at(-1) ?? "" }
  }, [chartRows])
  const primaryFrom = chartFrom || availableBounds.from
  const primaryTo = chartTo || availableBounds.to
  const invalidPrimaryRange = Boolean(
    chartFrom && chartTo && chartFrom > chartTo,
  )
  const validComparison = Boolean(
    comparisonRange.from &&
      comparisonRange.to &&
      comparisonRange.from <= comparisonRange.to,
  )
  const invalidComparisonRange = Boolean(
    comparisonRange.from &&
      comparisonRange.to &&
      comparisonRange.from > comparisonRange.to,
  )
  const repeatedSeriesColor =
    normalizeHexColor(primaryColor) ===
    normalizeHexColor(comparisonRange.color)
  const primaryRows = useMemo(
    () =>
      chartRows.filter((row) => {
        const key = row.date.slice(0, 10)
        return (
          (!primaryFrom || key >= primaryFrom) &&
          (!primaryTo || key <= primaryTo)
        )
      }),
    [chartRows, primaryFrom, primaryTo],
  )
  const secondaryRows = useMemo(
    () =>
      validComparison
        ? chartRows.filter((row) => {
            const key = row.date.slice(0, 10)
            return key >= comparisonRange.from && key <= comparisonRange.to
          })
        : [],
    [
      chartRows,
      comparisonRange.from,
      comparisonRange.to,
      validComparison,
    ],
  )
  const primaryTotal = useMemo(
    () => primaryRows.reduce((sum, row) => sum + row.grossAmount, 0),
    [primaryRows],
  )
  const secondaryTotal = useMemo(
    () => secondaryRows.reduce((sum, row) => sum + row.grossAmount, 0),
    [secondaryRows],
  )
  const primaryDayCount = useMemo(
    () => getEvolutionPeriodKeys(primaryFrom, primaryTo, "day").length,
    [primaryFrom, primaryTo],
  )
  const secondaryDayCount = useMemo(
    () =>
      validComparison
        ? getEvolutionPeriodKeys(
            comparisonRange.from,
            comparisonRange.to,
            "day",
          ).length
        : 0,
    [comparisonRange.from, comparisonRange.to, validComparison],
  )
  const fullSeries = useMemo<EvolutionChartSeries[]>(() => {
    if (!primaryFrom || !primaryTo || primaryFrom > primaryTo) return []

    if (mode === "evolution") {
      const fromKey =
        grouping === "month" ? primaryFrom.slice(0, 7) : primaryFrom
      const toKey = grouping === "month" ? primaryTo.slice(0, 7) : primaryTo
      const keys = getEvolutionPeriodKeys(fromKey, toKey, grouping)

      return [
        {
          id: "primary",
          label: "Primera selección",
          color: primaryColor,
          from: primaryFrom,
          to: primaryTo,
          points: alignEvolutionPeriods(
            groupEvolutionSales(primaryRows, grouping),
            keys,
            fromKey,
            toKey,
            grouping,
          ),
          total: primaryTotal,
          averageDaily:
            primaryDayCount > 0 ? primaryTotal / primaryDayCount : 0,
        },
      ]
    }

    const relativeLength = Math.max(primaryDayCount, secondaryDayCount, 1)
    const series: EvolutionChartSeries[] = [
      {
        id: "primary",
        label: "Primera selección",
        color: primaryColor,
        from: primaryFrom,
        to: primaryTo,
        points: alignRelativeEvolutionPeriods(
          groupEvolutionSales(primaryRows, "day"),
          primaryFrom,
          primaryTo,
          relativeLength,
        ),
        total: primaryTotal,
        averageDaily:
          primaryDayCount > 0 ? primaryTotal / primaryDayCount : 0,
      },
    ]

    if (validComparison) {
      series.push({
        id: comparisonRange.id,
        label: "Segunda selección",
        color: comparisonRange.color,
        from: comparisonRange.from,
        to: comparisonRange.to,
        points: alignRelativeEvolutionPeriods(
          groupEvolutionSales(secondaryRows, "day"),
          comparisonRange.from,
          comparisonRange.to,
          relativeLength,
        ),
        total: secondaryTotal,
        averageDaily:
          secondaryDayCount > 0 ? secondaryTotal / secondaryDayCount : 0,
      })
    }

    return series
  }, [
    comparisonRange.color,
    comparisonRange.from,
    comparisonRange.id,
    comparisonRange.to,
    grouping,
    mode,
    primaryColor,
    primaryDayCount,
    primaryFrom,
    primaryRows,
    primaryTo,
    primaryTotal,
    secondaryDayCount,
    secondaryRows,
    secondaryTotal,
    validComparison,
  ])
  const domainLength = fullSeries[0]?.points.length ?? 0
  const windowStartIndex =
    domainLength > 1
      ? Math.min(
          domainLength - 1,
          Math.floor((visibleRange.from / 100) * (domainLength - 1)),
        )
      : 0
  const windowEndIndex =
    domainLength > 1
      ? Math.max(
          windowStartIndex,
          Math.ceil((visibleRange.to / 100) * (domainLength - 1)),
        )
      : 0
  const visibleSeries = useMemo(
    () =>
      fullSeries.map((series) => ({
        ...series,
        points: series.points.slice(windowStartIndex, windowEndIndex + 1),
      })),
    [fullSeries, windowEndIndex, windowStartIndex],
  )
  const chartPoints = useMemo(
    () =>
      visibleSeries
        .flatMap((series) => series.points)
        .filter(
          (point): point is EvolutionPoint & { value: number } =>
            point.value !== null,
        ),
    [visibleSeries],
  )
  const peakValues = useMemo(
    () =>
      new Map(
        fullSeries.map((series) => {
          const values = series.points
            .map((point) => point.value)
            .filter((value): value is number => value !== null)

          return [series.id, values.length ? Math.max(...values) : null]
        }),
      ),
    [fullSeries],
  )
  const maxValue = Math.max(...chartPoints.map((point) => point.value), 1)
  const difference = validComparison
    ? secondaryTotal - primaryTotal
    : null
  const absoluteDifference =
    difference === null ? null : Math.abs(difference)
  const variation =
    difference !== null && primaryTotal !== 0
      ? (difference / primaryTotal) * 100
      : null
  const visiblePointCount = visibleSeries[0]?.points.length ?? 0
  const width =
    mode === "evolution" && grouping === "month"
      ? Math.max(760, visiblePointCount * 64 + 110)
      : 760
  const height = 260
  const padding = { top: 30, right: 24, bottom: 58, left: 86 }
  const plotWidth = width - padding.left - padding.right
  const plotHeight = height - padding.top - padding.bottom
  const yTicks = useMemo(
    () =>
      Array.from({ length: 5 }, (_, index) => {
        const ratio = index / 4
        return {
          value: maxValue * (1 - ratio),
          y: padding.top + plotHeight * ratio,
        }
      }),
    [maxValue, padding.top, plotHeight],
  )
  const makePath = useCallback(
    (points: EvolutionPoint[]) => {
      let drawing = false

      return points
        .map((point, index) => {
          if (point.value === null) {
            drawing = false
            return ""
          }

          const x =
            points.length <= 1
              ? padding.left + plotWidth / 2
              : padding.left + (index / (points.length - 1)) * plotWidth
          const y =
            padding.top +
            plotHeight -
            (point.value / maxValue) * plotHeight
          const command = drawing ? "L" : "M"
          drawing = true
          return `${command} ${x} ${y}`
        })
        .filter(Boolean)
        .join(" ")
    },
    [maxValue, padding.left, padding.top, plotHeight, plotWidth],
  )
  const pointCoordinates = useCallback(
    (points: EvolutionPoint[]) =>
      points.flatMap((point, index) =>
        point.value === null
          ? []
          : [
              {
                ...point,
                value: point.value,
                index,
                x:
                  points.length <= 1
                    ? padding.left + plotWidth / 2
                    : padding.left +
                      (index / (points.length - 1)) * plotWidth,
                y:
                  padding.top +
                  plotHeight -
                  (point.value / maxValue) * plotHeight,
              },
            ],
      ),
    [maxValue, padding.left, padding.top, plotHeight, plotWidth],
  )
  const xLabelIndexes = useMemo(
    () =>
      getEvolutionTickIndexes(
        visiblePointCount,
        mode,
        grouping,
        chartViewportWidth < 480 ? 4 : chartViewportWidth < 720 ? 6 : 10,
      ),
    [chartViewportWidth, grouping, mode, visiblePointCount],
  )
  const currentRangeLabel =
    chartFrom && chartTo
      ? `${chartFrom.split("-").reverse().join("/")} – ${chartTo
          .split("-")
          .reverse()
          .join("/")}`
      : "Todas las fechas disponibles"
  const visibleRangeLabel = useMemo(() => {
    if (domainLength === 0) return "Sin ventana disponible"
    if (mode === "comparison") {
      return `Día ${windowStartIndex + 1} – Día ${windowEndIndex + 1}`
    }

    const first = fullSeries[0]?.points[windowStartIndex]
    const last = fullSeries[0]?.points[windowEndIndex]
    return first && last
      ? `${formatEvolutionTooltipDate(first.key)} — ${formatEvolutionTooltipDate(last.key)}`
      : "Ventana completa"
  }, [
    domainLength,
    fullSeries,
    mode,
    windowEndIndex,
    windowStartIndex,
  ])
  const tooltipEntries = activePoint
    ? visibleSeries.flatMap((series) => {
        const point = series.points[activePoint.index]
        const peak = peakValues.get(series.id)

        return !point || point.value === null
          ? []
          : [{ series, point, peak: peak !== null && point.value === peak }]
      })
    : []
  const tooltipDifference =
    tooltipEntries.length === 2
      ? tooltipEntries[1].point.value! - tooltipEntries[0].point.value!
      : null
  const tooltipHeight =
    34 + tooltipEntries.length * 20 + (tooltipDifference !== null ? 24 : 0)

  const selectPrimaryRange = (range: { from: string; to: string }) => {
    setChartFrom(range.from)
    setChartTo(range.to)
    setVisibleRange({ from: 0, to: 100 })
  }
  const exportCsv = useCallback(() => {
    if (!fullSeries.length) return

    const headers = [
      mode === "comparison" ? "Día relativo" : "Período",
      ...fullSeries.flatMap((series) => [
        `Fecha ${series.label}`,
        `Facturación ${series.label}`,
      ]),
    ]
    const data = Array.from({ length: domainLength }, (_, index) => [
      mode === "comparison"
        ? `Día ${index + 1}`
        : fullSeries[0]?.points[index]?.label ?? "",
      ...fullSeries.flatMap((series) => {
        const point = series.points[index]
        return [
          point && /^\d{4}-\d{2}(?:-\d{2})?$/.test(point.key)
            ? point.key
            : "",
          point?.value ?? "",
        ]
      }),
    ])
    const escapeCell = (value: string | number) =>
      `"${String(value).replaceAll('"', '""')}"`
    const csv = [headers, ...data]
      .map((row) => row.map(escapeCell).join(","))
      .join("\r\n")
    const blob = new Blob([`\uFEFF${csv}`], {
      type: "text/csv;charset=utf-8",
    })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = `facturacion-${mode}-${new Date()
      .toISOString()
      .slice(0, 10)}.csv`
    link.click()
    URL.revokeObjectURL(url)
  }, [domainLength, fullSeries, mode])
  const downloadChart = useCallback(() => {
    const svg = svgRef.current
    if (!svg) return

    const clone = svg.cloneNode(true) as SVGSVGElement
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg")
    const source = new XMLSerializer().serializeToString(clone)
    const blob = new Blob([source], {
      type: "image/svg+xml;charset=utf-8",
    })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = `facturacion-${mode}-${new Date()
      .toISOString()
      .slice(0, 10)}.svg`
    link.click()
    URL.revokeObjectURL(url)
  }, [mode])

  return (
    <div className="grid gap-3 xl:grid-cols-3 xl:items-start">
      <section className="rounded-2xl border border-white/8 bg-[#141414] p-4 xl:col-span-2">
        <SectionHeader
          eyebrow="Facturación"
          title={mode === "evolution" ? "Evolución" : "Comparación"}
        />
        <div className="rounded-2xl border border-white/7 bg-black p-3 sm:p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <p className="text-sm font-black text-white">
                Facturación por período
              </p>
              <p className="mt-1 max-w-2xl text-xs leading-5 text-white/45">
                {mode === "evolution"
                  ? "Línea temporal continua sobre el calendario real."
                  : "Períodos alineados desde su primer día para comparar la evolución relativa."}
              </p>
              <p className="mt-1 text-11px font-semibold text-beyonix-sky/75">
                {currentRangeLabel}
              </p>
            </div>

            <div className="grid w-full grid-cols-2 rounded-xl border border-white/10 bg-white/[0.025] p-1 sm:w-[310px]">
              {([
                ["evolution", "Evolución"],
                ["comparison", "Comparación"],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={mode === value}
                  onClick={() => {
                    setMode(value)
                    setActivePoint(null)
                    setVisibleRange({ from: 0, to: 100 })
                  }}
                  className={`h-9 cursor-pointer rounded-lg text-xs font-black transition ${
                    mode === value
                      ? value === "comparison"
                        ? "bg-beyonix-blue/45 text-beyonix-sky"
                        : "bg-sky-500/20 text-sky-100"
                      : "text-white/45 hover:bg-white/[0.04] hover:text-white"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-3 rounded-2xl border border-white/8 bg-white/[0.025] p-2.5">
            <p className="mb-2 text-10px font-black uppercase tracking-widest text-white/38">
              Primera selección
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <div className="w-[150px]">
                <FilterField label="Desde">
                  <AdminDatePicker
                    title="Desde — Primera selección"
                    ariaLabel="Fecha inicial de la primera selección"
                    value={chartFrom}
                    placeholder="Desde"
                    compact
                    onSelectMonth={selectPrimaryRange}
                    onSelectYear={selectPrimaryRange}
                    onChange={setChartFrom}
                  />
                </FilterField>
              </div>
              <div className="w-[150px]">
                <FilterField label="Hasta">
                  <AdminDatePicker
                    title="Hasta — Primera selección"
                    ariaLabel="Fecha final de la primera selección"
                    value={chartTo}
                    placeholder="Hasta"
                    compact
                    onSelectMonth={selectPrimaryRange}
                    onSelectYear={selectPrimaryRange}
                    onChange={setChartTo}
                  />
                </FilterField>
              </div>

              {mode === "evolution" ? (
                <div className="w-[104px] shrink-0">
                  <FilterField label="Agrupar">
                    <div className="grid h-11 grid-cols-2 overflow-hidden rounded-xl border border-white/10 bg-black/25">
                      {([
                        ["month", "Mes"],
                        ["day", "Día"],
                      ] as const).map(([value, label], index) => (
                        <button
                          key={value}
                          type="button"
                          aria-pressed={grouping === value}
                          onClick={() => {
                            setGrouping(value)
                            setVisibleRange({ from: 0, to: 100 })
                          }}
                          className={`text-11px font-black transition ${
                            index ? "border-l border-white/8" : ""
                          } ${
                            grouping === value
                              ? "bg-beyonix-blue text-white"
                              : "text-white/48 hover:bg-white/[0.04]"
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </FilterField>
                </div>
              ) : (
                <div>
                  <p className="mb-1.5 text-10px font-black uppercase tracking-widest text-white/38">
                    Alineación
                  </p>
                  <span className="inline-flex h-11 items-center rounded-xl border border-beyonix-sky/20 bg-beyonix-blue/24 px-3 text-11px font-black text-beyonix-sky">
                    Día relativo
                  </span>
                </div>
              )}

              <EvolutionColorPicker
                value={primaryColor}
                label="Color 1"
                defaultColor="#38BDF8"
                onChange={setPrimaryColor}
              />

              {availableChannels.length > 1 && (
                <div className="min-w-[180px]">
                  <FilterField label="Canal">
                    <AdminSelect
                      title="Canal de venta"
                      ariaLabel="Filtrar gráfico por canal de venta"
                      value={chartChannel}
                      leadingIcon={<Store className="size-4 text-beyonix-sky/70" />}
                      searchable={availableChannels.length > 7}
                      searchPlaceholder="Buscar canal..."
                      triggerClassName="min-w-0 max-w-[240px]"
                      onChange={(value) => {
                        setChartChannel(value as SalesChannel)
                        setVisibleRange({ from: 0, to: 100 })
                      }}
                    >
                      <option value="todos">Todos los canales</option>
                      {availableChannels.map((channel) => (
                        <option key={channel} value={channel}>
                          {channel}
                        </option>
                      ))}
                    </AdminSelect>
                  </FilterField>
                </div>
              )}

              <button
                type="button"
                onClick={() => {
                  setChartFrom("")
                  setChartTo("")
                  setVisibleRange({ from: 0, to: 100 })
                }}
                disabled={!chartFrom && !chartTo}
                className="h-11 cursor-pointer rounded-xl border border-white/8 px-3 text-11px font-black text-white/45 hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
              >
                Limpiar fechas
              </button>
            </div>

            {mode === "comparison" && (
              <div className="mt-2.5 rounded-2xl border border-beyonix-sky/18 bg-beyonix-blue/10 p-2.5">
                <p className="mb-2 text-10px font-black uppercase tracking-widest text-beyonix-sky/65">
                  Segunda selección
                </p>
                <div className="flex flex-wrap items-end gap-2">
                  <div className="w-[150px]">
                    <FilterField label="Desde">
                      <AdminDatePicker
                        title="Desde — Segunda selección"
                        ariaLabel="Fecha inicial de la segunda selección"
                        value={comparisonRange.from}
                        placeholder="Desde"
                        compact
                        onSelectMonth={(range) =>
                          setComparisonRange((current) => ({
                            ...current,
                            ...range,
                          }))
                        }
                        onSelectYear={(range) =>
                          setComparisonRange((current) => ({
                            ...current,
                            ...range,
                          }))
                        }
                        onChange={(from) =>
                          setComparisonRange((current) => ({
                            ...current,
                            from,
                          }))
                        }
                      />
                    </FilterField>
                  </div>
                  <div className="w-[150px]">
                    <FilterField label="Hasta">
                      <AdminDatePicker
                        title="Hasta — Segunda selección"
                        ariaLabel="Fecha final de la segunda selección"
                        value={comparisonRange.to}
                        placeholder="Hasta"
                        compact
                        onSelectMonth={(range) =>
                          setComparisonRange((current) => ({
                            ...current,
                            ...range,
                          }))
                        }
                        onSelectYear={(range) =>
                          setComparisonRange((current) => ({
                            ...current,
                            ...range,
                          }))
                        }
                        onChange={(to) =>
                          setComparisonRange((current) => ({
                            ...current,
                            to,
                          }))
                        }
                      />
                    </FilterField>
                  </div>
                  <EvolutionColorPicker
                    value={comparisonRange.color}
                    label="Color 2"
                    defaultColor="#A78BFA"
                    onChange={(color) =>
                      setComparisonRange((current) => ({
                        ...current,
                        color,
                      }))
                    }
                  />
                </div>
                {invalidComparisonRange && (
                  <p className="mt-2 text-xs font-semibold text-red-300">
                    “Desde” no puede ser posterior a “Hasta”.
                  </p>
                )}
                {repeatedSeriesColor && (
                  <p className="mt-2 text-xs font-semibold text-amber-200/75">
                    Elegí colores diferentes para distinguir mejor los
                    períodos.
                  </p>
                )}
              </div>
            )}

            {invalidPrimaryRange && (
              <p className="mt-3 text-xs font-semibold text-red-300">
                La fecha “Desde” no puede ser posterior a “Hasta”.
              </p>
            )}
          </div>

          <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <EvolutionMetric
              label="Total por período"
              lines={[
                {
                  color: primaryColor,
                  value: hidden ? HIDDEN_AMOUNT : formatPrice(primaryTotal),
                },
                {
                  color: validComparison
                    ? comparisonRange.color
                    : "rgba(255,255,255,.28)",
                  value: validComparison
                    ? hidden
                      ? HIDDEN_AMOUNT
                      : formatPrice(secondaryTotal)
                    : "—",
                },
              ]}
            />
            <EvolutionMetric
              label="Diferencia absoluta"
              value={
                absoluteDifference === null
                  ? "—"
                  : hidden
                    ? HIDDEN_AMOUNT
                    : formatPrice(absoluteDifference)
              }
              helper="Magnitud entre períodos"
            />
            <EvolutionMetric
              label="Variación"
              value={
                variation === null
                  ? "—"
                  : hidden
                    ? "****"
                    : `${variation >= 0 ? "+" : ""}${variation.toFixed(1)}%`
              }
              tone={
                variation === null
                  ? "neutral"
                  : variation >= 0
                    ? "positive"
                    : "negative"
              }
              helper="Segunda respecto de primera"
            />
            <EvolutionMetric
              label="Promedio diario"
              lines={[
                {
                  color: primaryColor,
                  value: hidden
                    ? HIDDEN_AMOUNT
                    : formatPrice(
                        primaryDayCount > 0
                          ? primaryTotal / primaryDayCount
                          : 0,
                      ),
                },
                {
                  color: validComparison
                    ? comparisonRange.color
                    : "rgba(255,255,255,.28)",
                  value: validComparison
                    ? hidden
                      ? HIDDEN_AMOUNT
                      : formatPrice(
                          secondaryDayCount > 0
                            ? secondaryTotal / secondaryDayCount
                            : 0,
                        )
                    : "—",
                },
              ]}
            />
          </div>

          <div className="mt-3 rounded-2xl border border-white/8 bg-white/[0.02] p-3">
            <div className="flex flex-wrap items-center justify-end gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  aria-pressed={showAverage}
                  onClick={() => setShowAverage((current) => !current)}
                  className={`h-9 cursor-pointer rounded-xl border px-3 text-11px font-black ${
                    showAverage
                      ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-200"
                      : "border-white/8 text-white/45 hover:text-white"
                  }`}
                >
                  Línea de promedio
                </button>
                <button
                  type="button"
                  onClick={exportCsv}
                  disabled={!chartPoints.length || hidden}
                  title={
                    hidden
                      ? "Mostrá los valores para exportar"
                      : "Exportar períodos completos a CSV"
                  }
                  className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-xl border border-white/8 px-3 text-11px font-black text-white/48 hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
                >
                  <Download className="size-3.5" />
                  CSV
                </button>
                <button
                  type="button"
                  onClick={downloadChart}
                  disabled={!chartPoints.length || hidden}
                  title={hidden ? "Mostrá los valores para descargar" : "Descargar imagen SVG"}
                  className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-xl border border-white/8 px-3 text-11px font-black text-white/48 hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
                >
                  <ImageDown className="size-3.5" />
                  SVG
                </button>
              </div>
            </div>

            <div className="mt-3">
              <TemporalBrush
                value={visibleRange}
                label={`Vista: ${visibleRangeLabel}`}
                disabled={domainLength <= 1}
                onChange={setVisibleRange}
              />
            </div>
          </div>

          {chartPoints.length ? (
            <>
              <div ref={chartViewportRef} className="mt-4 overflow-x-auto">
                <svg
                  ref={svgRef}
                  viewBox={`0 0 ${width} ${height}`}
                  role="img"
                  aria-label={
                    mode === "evolution"
                      ? "Evolución temporal de la facturación"
                      : "Comparación relativa de la facturación"
                  }
                  className="min-w-680px w-full"
                >
                  {yTicks.map((tick) => (
                    <g key={tick.y}>
                      <line
                        x1={padding.left}
                        y1={tick.y}
                        x2={width - padding.right}
                        y2={tick.y}
                        stroke="rgba(255,255,255,0.09)"
                        strokeDasharray="4 5"
                      />
                      <text
                        x={padding.left - 12}
                        y={tick.y + 4}
                        textAnchor="end"
                        fill="rgba(255,255,255,0.42)"
                        fontSize="11"
                      >
                        {formatEvolutionAxisAmount(tick.value, hidden)}
                      </text>
                    </g>
                  ))}
                  <line
                    x1={padding.left}
                    y1={padding.top}
                    x2={padding.left}
                    y2={height - padding.bottom}
                    stroke="rgba(255,255,255,0.2)"
                  />
                  <line
                    x1={padding.left}
                    y1={height - padding.bottom}
                    x2={width - padding.right}
                    y2={height - padding.bottom}
                    stroke="rgba(255,255,255,0.2)"
                  />

                  {showAverage &&
                    visibleSeries.map((series) => {
                      const values = series.points
                        .map((point) => point.value)
                        .filter((value): value is number => value !== null)
                      const average =
                        values.reduce((sum, value) => sum + value, 0) /
                        Math.max(values.length, 1)
                      const y =
                        padding.top +
                        plotHeight -
                        (average / maxValue) * plotHeight

                      return (
                        <g key={`average-${series.id}`}>
                          <line
                            x1={padding.left}
                            y1={y}
                            x2={width - padding.right}
                            y2={y}
                            stroke={series.color}
                            strokeWidth="1.5"
                            strokeOpacity="0.42"
                          />
                          <text
                            x={width - padding.right}
                            y={Math.max(padding.top + 10, y - 5)}
                            textAnchor="end"
                            fill={series.color}
                            fillOpacity="0.72"
                            fontSize="9"
                            fontWeight="700"
                          >
                            Prom.
                          </text>
                        </g>
                      )
                    })}

                  {visibleSeries.map((series) => (
                    <path
                      key={`line-${series.id}`}
                      d={makePath(series.points)}
                      fill="none"
                      stroke={series.color}
                      strokeWidth={series.id === "primary" ? "3" : "2.5"}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  ))}

                  {visibleSeries.flatMap((series) => {
                    const peak = peakValues.get(series.id)

                    return pointCoordinates(series.points).map((point) => {
                      const isPeak = peak !== null && point.value === peak
                      const showMarker = isPeak || visiblePointCount <= 60
                      return (
                        <circle
                          key={`${series.id}-${point.key}`}
                          cx={point.x}
                          cy={point.y}
                          r={
                            isPeak && peak > 0
                              ? "4.5"
                              : showMarker
                                ? "2.5"
                                : "6"
                          }
                          fill={series.color}
                          fillOpacity={showMarker ? "1" : "0"}
                          stroke={isPeak && peak > 0 ? "#ffffff" : "#020617"}
                          strokeWidth={
                            isPeak && peak > 0
                              ? "1.75"
                              : showMarker
                                ? "1"
                                : "0"
                          }
                          tabIndex={showMarker ? 0 : -1}
                          className="cursor-pointer outline-none"
                          onMouseEnter={() =>
                            setActivePoint({
                              index: point.index,
                              x: point.x,
                              y: point.y,
                              color: series.color,
                            })
                          }
                          onMouseLeave={() => setActivePoint(null)}
                          onFocus={() =>
                            setActivePoint({
                              index: point.index,
                              x: point.x,
                              y: point.y,
                              color: series.color,
                            })
                          }
                          onBlur={() => setActivePoint(null)}
                          onClick={() =>
                            setActivePoint({
                              index: point.index,
                              x: point.x,
                              y: point.y,
                              color: series.color,
                            })
                          }
                        >
                          <title>
                            {series.label} ·{" "}
                            {formatEvolutionTooltipDate(point.key)}:{" "}
                            {hidden ? HIDDEN_AMOUNT : formatPrice(point.value)}
                          </title>
                        </circle>
                      )
                    })
                  })}

                  {xLabelIndexes.map((index) => {
                    const point = visibleSeries[0]?.points[index]
                    const x =
                      visiblePointCount <= 1
                        ? padding.left + plotWidth / 2
                        : padding.left +
                          (index / (visiblePointCount - 1)) * plotWidth

                    return point ? (
                      <text
                        key={`${point.key}-${index}`}
                        x={x}
                        y={height - 22}
                        textAnchor={
                          index === 0
                            ? "start"
                            : index === visiblePointCount - 1
                              ? "end"
                              : "middle"
                        }
                        fill="rgba(255,255,255,0.5)"
                        fontSize="11"
                      >
                        {formatEvolutionAxisLabel(
                          point,
                          mode,
                          grouping,
                          visiblePointCount,
                          windowStartIndex + index + 1,
                        )}
                      </text>
                    ) : null
                  })}

                  {activePoint && tooltipEntries.length > 0 && (
                    <g
                      pointerEvents="none"
                      transform={`translate(${Math.min(
                        Math.max(activePoint.x, 166),
                        width - 166,
                      )}, ${Math.min(
                        Math.max(
                          activePoint.y < height / 2
                            ? activePoint.y + 14
                            : activePoint.y - tooltipHeight - 12,
                          8,
                        ),
                        height - tooltipHeight - 8,
                      )})`}
                    >
                      <rect
                        x="-158"
                        y="0"
                        width="316"
                        height={tooltipHeight}
                        rx="12"
                        fill="#07111d"
                        stroke={activePoint.color}
                        strokeOpacity="0.65"
                      />
                      <text
                        x="-142"
                        y="20"
                        fill="rgba(255,255,255,0.58)"
                        fontSize="10"
                        fontWeight="700"
                      >
                        {mode === "comparison"
                          ? `Día relativo ${windowStartIndex + activePoint.index + 1}`
                          : tooltipEntries[0].point.label}
                      </text>
                      {tooltipEntries.map((entry, index) => (
                        <g
                          key={`tooltip-${entry.series.id}`}
                          transform={`translate(0, ${34 + index * 20})`}
                        >
                          <circle
                            cx="-142"
                            cy="-3"
                            r="3.5"
                            fill={entry.series.color}
                          />
                          <text
                            x="-132"
                            y="0"
                            fill={entry.series.color}
                            fontSize="10"
                            fontWeight="700"
                          >
                            {entry.series.label}
                          </text>
                          <text
                            x="-20"
                            y="0"
                            textAnchor="middle"
                            fill="rgba(255,255,255,0.62)"
                            fontSize="10"
                          >
                            {formatEvolutionTooltipDate(entry.point.key)}
                          </text>
                          <text
                            x="142"
                            y="0"
                            textAnchor="end"
                            fill="white"
                            fontSize="11"
                            fontWeight="800"
                          >
                            {hidden
                              ? HIDDEN_AMOUNT
                              : formatPrice(entry.point.value!)}
                            {entry.peak ? " · Pico" : ""}
                          </text>
                        </g>
                      ))}
                      {tooltipDifference !== null && (
                        <text
                          x="-142"
                          y={tooltipHeight - 10}
                          fill={
                            tooltipDifference >= 0 ? "#6ee7b7" : "#fca5a5"
                          }
                          fontSize="10"
                          fontWeight="800"
                        >
                          Diferencia:{" "}
                          {hidden
                            ? HIDDEN_AMOUNT
                            : `${tooltipDifference >= 0 ? "+" : ""}${formatPrice(
                                tooltipDifference,
                              )}`}
                        </text>
                      )}
                    </g>
                  )}
                </svg>
              </div>

              <div className="mt-2 flex flex-wrap items-center justify-between gap-3 text-11px">
                <div className="flex flex-wrap gap-4 text-white/48">
                  {visibleSeries.map((series) => (
                    <span
                      key={`legend-${series.id}`}
                      className="inline-flex items-center gap-2"
                    >
                      <span
                        className="h-0.5 w-5"
                        style={{ backgroundColor: series.color }}
                      />
                      {series.label}
                    </span>
                  ))}
                </div>
                <span className="font-semibold text-white/35">
                  El borde blanco resalta el pico de cada período.
                </span>
              </div>
            </>
          ) : (
            <p className="flex min-h-220px items-center justify-center text-sm text-white/45">
              No hay datos para graficar con los filtros seleccionados.
            </p>
          )}
        </div>
      </section>

      <div className="space-y-4">
        <section className="rounded-3xl border border-white/8 bg-[#141414] p-5">
          <SectionHeader eyebrow="Canales" title="Ventas por canal" />
          <BarList rows={channelRows} valueKey="amount" hidden={hidden} />
        </section>
        <section className="rounded-3xl border border-white/8 bg-[#141414] p-5">
          <SectionHeader eyebrow="Períodos" title="Facturación por selección" />
          <div className="space-y-2">
            <EvolutionPeriodTotal
              label="Primera selección"
              color={primaryColor}
              range={`${primaryFrom.split("-").reverse().join("/")} – ${primaryTo
                .split("-")
                .reverse()
                .join("/")}`}
              total={primaryTotal}
              hidden={hidden}
            />
            {mode === "comparison" && validComparison && (
              <EvolutionPeriodTotal
                label="Segunda selección"
                color={comparisonRange.color}
                range={`${comparisonRange.from
                  .split("-")
                  .reverse()
                  .join("/")} – ${comparisonRange.to
                  .split("-")
                  .reverse()
                  .join("/")}`}
                total={secondaryTotal}
                hidden={hidden}
                variation={variation}
              />
            )}
          </div>
        </section>
      </div>
    </div>
  )
}

function EvolutionMetric({
  label,
  value,
  helper,
  tone = "neutral",
  lines,
}: {
  label: string
  value?: string
  helper?: string
  tone?: "neutral" | "positive" | "negative"
  lines?: { color: string; value: string }[]
}) {
  return (
    <div className="rounded-2xl border border-white/8 bg-white/[0.025] p-3">
      <p className="text-10px font-black uppercase tracking-widest text-white/38">
        {label}
      </p>
      {lines ? (
        <div className="mt-2 space-y-1">
          {lines.map((line, index) => (
            <p
              key={`${line.color}-${index}`}
              className="text-sm font-black"
              style={{ color: line.color }}
            >
              {index + 1}. {line.value}
            </p>
          ))}
        </div>
      ) : (
        <p
          className={`mt-2 text-base font-black ${
            tone === "positive"
              ? "text-emerald-300"
              : tone === "negative"
                ? "text-red-300"
                : "text-white"
          }`}
        >
          {value}
        </p>
      )}
      {helper && (
        <p className="mt-1 text-10px font-semibold text-white/35">{helper}</p>
      )}
    </div>
  )
}

function EvolutionPeriodTotal({
  label,
  color,
  range,
  total,
  hidden,
  variation,
}: {
  label: string
  color: string
  range: string
  total: number
  hidden: boolean
  variation?: number | null
}) {
  return (
    <div
      className="rounded-2xl border bg-white/[0.035] px-4 py-3"
      style={{ borderColor: `${color}33` }}
    >
      <p
        className="flex items-center gap-2 text-10px font-black uppercase tracking-widest"
        style={{ color }}
      >
        <span className="size-2 rounded-full" style={{ backgroundColor: color }} />
        {label}
      </p>
      <p className="mt-1 text-11px font-semibold text-white/42">{range}</p>
      <p className="mt-1 text-lg font-black text-white">
        {hidden ? HIDDEN_AMOUNT : formatPrice(total)}
      </p>
      {variation != null && (
        <p
          className={`mt-1 text-xs font-bold ${
            variation >= 0 ? "text-emerald-300" : "text-red-300"
          }`}
        >
          {hidden
            ? "Variación: ****"
            : `${variation >= 0 ? "+" : ""}${variation.toFixed(1)}% respecto de la primera selección`}
        </p>
      )}
    </div>
  )
}

function BarList({
  rows,
  valueKey,
  hidden = false,
}: {
  rows: { label: string; value: number; amount?: number }[]
  valueKey: "value" | "amount"
  hidden?: boolean
}) {
  const max = Math.max(
    ...rows.map((row) => Number(row[valueKey] ?? row.value)),
    1
  )

  return (
    <div className="space-y-3 rounded-3xl border border-white/7 bg-black p-4">
      {rows.length ? (
        rows.slice(0, 7).map((row) => {
          const value = Number(row[valueKey] ?? row.value)
          return (
            <div key={row.label} className="grid gap-2">
              <div className="flex items-center justify-between gap-4 text-sm">
                <span className="truncate font-bold text-white">{row.label}</span>
                <span className="shrink-0 text-xs font-black text-white/70">
                  {valueKey === "amount"
                    ? hidden
                      ? HIDDEN_AMOUNT
                      : formatPrice(value)
                    : value}
                </span>
              </div>
              <div className="h-2 rounded-full bg-white/6">
                <div
                  className="h-full rounded-full bg-beyonix-sky"
                  style={{ width: `${Math.max(4, (value / max) * 100)}%` }}
                />
              </div>
            </div>
          )
        })
      ) : (
        <p className="py-10 text-center text-sm text-white/45">
          No hay datos para este filtro.
        </p>
      )}
    </div>
  )
}

export function AdminDashboard() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const notificationGroups = useAdminNotificationGroups()
  const hasPendingMercadoLibreReturns =
    notificationGroups.mercadolibre_return > 0
  const onNavigate = useCallback(
    (section: AdminRouteKey) => router.push(ADMIN_ROUTES[section]),
    [router],
  )
  const { stock: stockSettings } = useSiteSettings()
  const {
    stats,
    financialSummary,
    role,
    lowStock,
    recentOrders,
    commercialSales,
    recentActivity,
    systemStatus,
    searchIndex,
    loading,
    error,
    reloadDashboard,
    healthRefreshing,
    healthReady,
    healthCheckedAt,
    healthError,
    refreshSystemHealth,
  } = useDashboard()
  const requestedTab = searchParams.get("tab")
  const [tab, setTab] = useState<DashboardTab>(
    requestedTab === "comercial" ||
      requestedTab === "externas" ||
      requestedTab === "ml" ||
      requestedTab === "costos"
      ? requestedTab
      : "operativo",
  )
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const [month, setMonth] = useState("")
  const [year, setYear] = useState("")
  const [channel, setChannel] = useState<SalesChannel>("todos")
  const [product, setProduct] = useState("")
  const [category, setCategory] = useState("")
  const [sortKey, setSortKey] = useState<SortKey>("grossAmount")
  const [hiddenValues, setHiddenValues] = useState(() => {
    if (typeof window === "undefined") return true
    return window.localStorage.getItem("beyonix-hide-dashboard-values") !== "false"
  })

  useEffect(() => {
    if (
      requestedTab === "operativo" ||
      requestedTab === "comercial" ||
      requestedTab === "externas" ||
      requestedTab === "ml" ||
      requestedTab === "costos"
    ) {
      setTab(requestedTab)
    }
  }, [requestedTab])

  if (loading || !stats || !financialSummary) return <Skeleton />
  const sensitive = role === "admin" || role === "super_admin"
  const today = new Date()
  const hasCustomDateFilter = Boolean(from || to)

  const filteredSales = commercialSales.filter((sale) => {
    const date = new Date(sale.date)
    return (
      (!from || date >= new Date(`${from}T00:00:00`)) &&
      (!to || date <= new Date(`${to}T23:59:59`)) &&
      (hasCustomDateFilter || !month || date.getMonth() === Number(month)) &&
      (hasCustomDateFilter || !year || date.getFullYear() === Number(year)) &&
      (channel === "todos" || sale.channel === channel) &&
      (!product || sale.productName === product) &&
      (!category || sale.categoryName === category)
    )
  })
  const evolutionSales = commercialSales.filter(
    (sale) =>
      (channel === "todos" || sale.channel === channel) &&
      (!product || sale.productName === product) &&
      (!category || sale.categoryName === category),
  )
  const productOptions = Array.from(
    new Set(commercialSales.map((sale) => sale.productName))
  ).sort()
  const categoryOptions = Array.from(
    new Set(commercialSales.map((sale) => sale.categoryName).filter(Boolean))
  ).sort() as string[]
  const yearOptions = Array.from(
    new Set(
      commercialSales.map((sale) => String(new Date(sale.date).getFullYear()))
    )
  ).sort((a, b) => Number(b) - Number(a))
  const filteredSalesWithDate = filteredSales.map((sale) => ({
    sale,
    date: new Date(sale.date),
  }))
  const commercialStats = {
    facturacionDiaria: filteredSalesWithDate
      .filter(({ date }) => isSameDay(date, today))
      .reduce((total, { sale }) => total + sale.grossAmount, 0),
    facturacionMensual: filteredSalesWithDate
      .filter(({ date }) => matchesMetricMonth(date, month, year, today))
      .reduce((total, { sale }) => total + sale.grossAmount, 0),
    facturacionAnual: filteredSalesWithDate
      .filter(({ date }) => matchesMetricYear(date, year, today))
      .reduce((total, { sale }) => total + sale.grossAmount, 0),
    facturacionTotalFiltrada: filteredSales.reduce((total, sale) => total + sale.grossAmount, 0),
    ventas: filteredSales.length,
    unidades: filteredSales.reduce((total, sale) => total + sale.quantity, 0),
  }
  const ticket =
    commercialStats.ventas > 0
      ? commercialStats.facturacionTotalFiltrada / commercialStats.ventas
      : 0
  const invoiceCoverage =
    financialSummary.paidOrders > 0
      ? (financialSummary.invoicedOrders / financialSummary.paidOrders) * 100
      : 100
  const byChannel = [
    "BEYONIX Web",
    "MercadoLibre Marketplace",
    "Ventas externas",
  ].map((label) => ({
    label,
    value: filteredSales
      .filter((sale) => sale.channel === label)
      .reduce((total, sale) => total + sale.quantity, 0),
    amount: filteredSales
      .filter((sale) => sale.channel === label)
      .reduce((total, sale) => total + sale.grossAmount, 0),
  }))
  const byProduct = Array.from(
    filteredSales.reduce<
      Map<string, { label: string; value: number; amount: number }>
    >((acc, sale) => {
      const current = acc.get(sale.productName) ?? {
        label: sale.productName,
        value: 0,
        amount: 0,
      }
      current.value += sale.quantity
      current.amount += sale.grossAmount
      acc.set(sale.productName, current)
      return acc
    }, new Map())
  )
    .map(([, value]) => value)
    .sort((a, b) => b.value - a.value)
  const tableRows = [...filteredSales].sort((a, b) => {
    const ticketA = a.quantity ? a.grossAmount / a.quantity : 0
    const ticketB = b.quantity ? b.grossAmount / b.quantity : 0
    const values = {
      productName: a.productName.localeCompare(b.productName),
      channel: a.channel.localeCompare(b.channel),
      paymentMethod: a.paymentMethod.localeCompare(b.paymentMethod),
      quantity: b.quantity - a.quantity,
      grossAmount: b.grossAmount - a.grossAmount,
      costAmount: (b.costAmount ?? 0) - (a.costAmount ?? 0),
      profitAmount: (b.profitAmount ?? 0) - (a.profitAmount ?? 0),
      marginPercent: (b.marginPercent ?? 0) - (a.marginPercent ?? 0),
      ticket: ticketB - ticketA,
    }
    return values[sortKey]
  })
  const toggleHiddenValues = () => {
    setHiddenValues((current) => {
      window.localStorage.setItem(
        "beyonix-hide-dashboard-values",
        current ? "false" : "true"
      )
      return !current
    })
  }

  return (
    <div
      className="admin-dashboard-page min-w-0 space-y-4 p-3 sm:p-4 lg:p-5"
      data-dashboard-tab={tab}
    >
      <div className="admin-dashboard-hero rounded-2xl border border-beyonix-blue-light/22 bg-[radial-gradient(circle_at_18%_0%,rgba(140,200,242,0.12),transparent_34%),linear-gradient(145deg,rgba(7,16,24,0.98),rgba(3,7,13,0.94))] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_18px_44px_rgba(0,0,0,0.24)]">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div>
            <p className="mb-1 text-10px font-bold uppercase tracking-widest text-beyonix-sky">
              Panel administrativo
            </p>
            <h1 className="text-2xl font-black text-white lg:text-3xl">
              Dashboard BEYONIX
            </h1>
            <p className="mt-1.5 max-w-2xl text-xs leading-5 text-white/62 sm:text-sm">
              Centro operativo por defecto y análisis comercial separado para proteger información sensible.
            </p>
          </div>
          <div className="admin-dashboard-tabs-scroll min-w-0 max-w-full overflow-x-auto">
            <div className="admin-dashboard-tabs inline-flex min-w-max flex-nowrap rounded-xl border border-beyonix-blue-light/24 bg-black/30 p-1 shadow-inner shadow-black/40">
              {[
                ["operativo", "Centro operativo"],
                ["comercial", "Análisis comercial"],
                ...(sensitive
                  ? [
                      ["externas", "Ventas externas"],
                      ["ml", "Ventas ML"],
                      ["costos", "Compras"],
                    ]
                  : []),
              ].map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  aria-label={label}
                  onClick={() => setTab(key as DashboardTab)}
                  className={`inline-flex h-8 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-lg border px-3 text-xs font-black transition-all ${
                    tab === key
                      ? "border-beyonix-sky/36 bg-beyonix-blue/70 text-white shadow-[0_0_10px_rgba(96,165,250,0.10)]"
                      : "border-transparent text-white/62 hover:border-beyonix-blue-light/20 hover:bg-beyonix-blue/18 hover:text-white"
                  }`}
                >
                  {key === "operativo" ? (
                    <ShoppingCart className="size-3.5" />
                  ) : key === "externas" ? (
                    <Store className="size-3.5" />
                  ) : key === "ml" ? (
                    <Tags className="size-3.5" />
                  ) : key === "costos" ? (
                    <Package className="size-3.5" />
                  ) : (
                    <BarChart3 className="size-3.5" />
                  )}
                  {label}
                  {key === "ml" && hasPendingMercadoLibreReturns && (
                    <span
                      aria-label="Hay devoluciones de Mercado Libre pendientes"
                      title="Hay devoluciones de Mercado Libre pendientes"
                      className="size-2 rounded-full bg-amber-300 shadow-[0_0_8px_2px_rgba(252,211,77,0.76)]"
                    />
                  )}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-2xl border border-red-400/20 bg-red-400/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      {tab === "costos" ? (
        <AdminCostsPanel onChanged={() => void reloadDashboard()} />
      ) : tab === "externas" ? (
        <AdminSalesLedger channel="external" />
      ) : tab === "ml" ? (
        <AdminMercadoLibreSales />
      ) : tab === "operativo" ? (
        <>
          <section className="admin-dashboard-priorities rounded-2xl border border-beyonix-blue-light/16 bg-[linear-gradient(145deg,rgba(7,16,24,0.82),rgba(3,7,13,0.92))] p-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.025),0_14px_36px_rgba(0,0,0,0.16)] sm:p-4">
            <div className="mb-3 flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
              <SectionHeader eyebrow="Centro operativo" title="Prioridades de hoy" />
              <GlobalAdminSearch rows={searchIndex} onNavigate={onNavigate} />
            </div>
            <div className="grid gap-2.5 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
              <StatCard title="Pagos en revisión" value={stats.pagosEnRevision} helper={`${stats.esperandoComprobante} esperan comprobante`} icon={<CreditCard className="size-5" />} onClick={() => onNavigate("pedidos")} />
              <StatCard title="Pedidos a preparar" value={stats.enviosPendientes} helper={`${stats.pedidosSinTracking} sin tracking o etiqueta`} icon={<ShoppingCart className="size-5" />} onClick={() => onNavigate("pedidos")} />
              <StatCard title="Facturas pendientes" value={stats.facturasPendientes} helper="Pedidos pagados sin factura emitida" icon={<FileUp className="size-5" />} onClick={() => onNavigate("facturacion")} />
              <StatCard title="Facturas con error" value={stats.facturasConError} helper="Requieren corrección" icon={<ShieldAlert className="size-5" />} onClick={() => onNavigate("facturacion")} />
              <StatCard title="Reintegros pendientes" value={stats.reintegrosPendientes} helper="Dinero por devolver" icon={<RotateCcw className="size-5" />} onClick={() => onNavigate("pedidos")} />
              <StatCard title="Notas de crédito" value={stats.notasCreditoPendientes} helper="Pendientes de autorizar" icon={<ReceiptText className="size-5" />} onClick={() => onNavigate("facturacion")} />
            </div>
            <div className="mt-2.5 grid grid-cols-2 gap-2 xl:grid-cols-3 2xl:grid-cols-6">
              <FinancialMetric label="Pedidos totales" value={String(stats.totalOrdenes)} detail="Histórico" />
              <FinancialMetric label="Pedidos pagos" value={String(stats.pedidosPagados)} detail="Cobro confirmado" tone="positive" />
              <FinancialMetric label="Pendientes" value={String(stats.pedidosPendientes)} detail="Sin completar" tone={stats.pedidosPendientes > 0 ? "warning" : "neutral"} />
              <FinancialMetric label="Cancelados" value={String(stats.pedidosCancelados)} detail="Histórico" />
              <FinancialMetric label="Clientes" value={stats.totalClientes == null ? "—" : String(stats.totalClientes)} detail="Cuentas cliente" />
              <FinancialMetric label="Productos activos" value={String(stats.productosActivos)} detail={`${stats.productosBajoStock} con stock bajo`} tone={stats.productosBajoStock > 0 ? "warning" : "positive"} />
            </div>
          </section>

          {sensitive && (
            <section className="rounded-3xl border border-beyonix-blue-light/16 bg-[linear-gradient(145deg,rgba(7,16,24,0.78),rgba(3,7,13,0.92))] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.025)]">
              <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
                <div>
                  <p className="text-11px font-bold uppercase tracking-widest text-beyonix-cyan">
                    Conciliación
                  </p>
                  <h2 className="mt-1 text-base font-black text-white">
                    Controles críticos
                  </h2>
                </div>
                <p className="text-11px font-semibold text-white/38">
                  {financialSummary.complete
                    ? `${financialSummary.ordersScanned} pedidos verificados`
                    : "Lectura incompleta"}
                </p>
              </div>
              <div className="grid grid-cols-2 gap-2 xl:grid-cols-5">
                <ControlIndicator label="Cobros distintos" value={financialSummary.ordersWithPaymentMismatch} healthy={financialSummary.ordersWithPaymentMismatch === 0} onClick={() => onNavigate("pedidos")} />
                <ControlIndicator label="Envíos sin costo" value={financialSummary.ordersMissingShippingCost} healthy={financialSummary.ordersMissingShippingCost === 0} onClick={() => onNavigate("pedidos")} />
                <ControlIndicator label="Facturas con error" value={financialSummary.invoiceErrors} healthy={financialSummary.invoiceErrors === 0} onClick={() => onNavigate("facturacion")} />
                <ControlIndicator label="Notas pendientes" value={financialSummary.creditNotesPending} healthy={financialSummary.creditNotesPending === 0} onClick={() => onNavigate("facturacion")} />
                <ControlIndicator label="Stock negativo" value={financialSummary.negativeStockItems} healthy={financialSummary.negativeStockItems === 0} onClick={() => onNavigate("productos")} />
              </div>
            </section>
          )}

          <section className="rounded-3xl border border-beyonix-blue-light/16 bg-[linear-gradient(145deg,rgba(7,16,24,0.78),rgba(3,7,13,0.92))] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.025)]">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <p className="text-11px font-bold uppercase tracking-widest text-beyonix-cyan">
                  Sistema
                </p>
                <h2 className="mt-1 text-base font-black text-white">
                  Estado del sistema
                </h2>
                <p className="mt-1 text-10px font-semibold text-white/38">
                  Comprobaciones activas · actualización automática cada 30 segundos
                </p>
              </div>
              <div className="flex items-center gap-2">
                {healthCheckedAt && (
                  <span className="hidden text-right text-9px font-bold uppercase tracking-wide text-white/30 sm:block">
                    Última comprobación
                    <span className="block text-white/48">
                      {formatRelativeTime(healthCheckedAt)}
                    </span>
                  </span>
                )}
                <button
                  type="button"
                  aria-label="Comprobar ahora el estado del sistema"
                  title="Comprobar ahora"
                  onClick={() => void refreshSystemHealth()}
                  disabled={healthRefreshing}
                  className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-xl border border-beyonix-blue-light/22 bg-beyonix-blue/28 text-beyonix-sky transition hover:border-beyonix-sky/48 hover:bg-beyonix-blue/45 disabled:cursor-wait disabled:opacity-60"
                >
                  <RefreshCw
                    className={`size-4 ${healthRefreshing ? "animate-spin" : ""}`}
                  />
                </button>
              </div>
            </div>
            {healthError && (
              <p className="mb-2 rounded-lg border border-red-400/20 bg-red-400/8 px-3 py-2 text-10px font-semibold text-red-200">
                La última comprobación falló: {healthError}
              </p>
            )}
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              {systemStatus.map((item) => (
                <SystemStatusPill
                  key={item.id}
                  item={item}
                  ready={healthReady}
                />
              ))}
            </div>
          </section>

          <div className="grid gap-5 xl:grid-cols-2">
            <section className="rounded-3xl border border-beyonix-blue-light/16 bg-[linear-gradient(145deg,rgba(7,16,24,0.78),rgba(3,7,13,0.92))] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.025)]">
              <SectionHeader eyebrow="Operación" title="Últimos pedidos" />
              <div className="custom-scrollbar max-h-360px space-y-3 overflow-y-auto pr-1">
                {recentOrders.length ? recentOrders.map((order) => (
                  <button type="button" aria-label={`Abrir pedido ${order.id}`} key={order.id} onClick={() => onNavigate("pedidos")} className="flex w-full cursor-pointer items-center justify-between gap-4 rounded-2xl border border-beyonix-blue-light/14 bg-[rgba(3,7,13,0.72)] px-4 py-3 text-left transition hover:border-beyonix-sky/35 hover:bg-beyonix-blue/20">
                    <span className="min-w-0"><span className="block text-sm font-bold text-white">Pedido #{order.id}</span><span className="mt-1 block truncate text-xs text-white/45">{order.cliente_nombre || order.cliente_email || "Cliente"}</span></span>
                    <span className="text-right"><span className="block text-sm font-black text-white">{order.estado}</span><span className="mt-1 block text-11px uppercase text-white/42">{formatRelativeTime(order.created_at)}</span></span>
                  </button>
                )) : <EmptyState icon={<ShoppingCart className="size-5" />} title="No hay pedidos todavía" description="Cuando ingresen compras, van a aparecer acá." />}
              </div>
            </section>
            <section className="rounded-3xl border border-beyonix-blue-light/16 bg-[linear-gradient(145deg,rgba(7,16,24,0.78),rgba(3,7,13,0.92))] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.025)]">
              <SectionHeader eyebrow="Actividad" title="Actividad reciente" action={<button type="button" onClick={() => onNavigate("auditoria")} className="admin-ds-button admin-ds-button-secondary inline-flex cursor-pointer items-center gap-2 px-3 text-xs font-black transition">Ver auditoría <ArrowRight className="size-3.5" /></button>} />
              <div className="custom-scrollbar max-h-360px space-y-3 overflow-y-auto pr-1">
                {recentActivity.length ? recentActivity.map((item) => <ActivityItem key={item.id} item={item} />) : <EmptyState icon={<Clock className="size-5" />} title="No hay actividad reciente" description="Los movimientos operativos se mostrarán en este panel." />}
              </div>
            </section>
          </div>

          <section className="rounded-3xl border border-beyonix-blue-light/16 bg-[linear-gradient(145deg,rgba(7,16,24,0.78),rgba(3,7,13,0.92))] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.025)]">
            <SectionHeader eyebrow="Stock" title="Productos sin stock o bajo stock" action={<button type="button" aria-label="Ver productos" onClick={() => onNavigate("productos")} className="admin-ds-button admin-ds-button-secondary inline-flex cursor-pointer items-center gap-2 px-3 text-xs font-black transition">Ver productos <ArrowRight className="size-3.5" /></button>} />
            <div className="custom-scrollbar grid max-h-420px gap-3 overflow-y-auto pr-1 md:grid-cols-2 xl:grid-cols-3">
              {lowStock.length ? lowStock.map((item) => (
                <div key={item.id} className="rounded-2xl border border-beyonix-blue-light/14 bg-[rgba(3,7,13,0.72)] px-4 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.025)]">
                  <div className="flex items-start justify-between gap-3">
                    <span className="min-w-0"><span className="block truncate text-sm font-bold text-white">{item.producto_nombre || item.nombre}</span><span className="mt-1 flex items-center gap-2 truncate text-xs text-white/45">{item.color_hex && <span className="size-3 rounded-full border border-white/20" style={{ backgroundColor: item.color_hex }} />}{item.tipo === "variante" ? item.nombre : "Producto"}</span><span className="mt-2 block text-11px font-bold uppercase tracking-widest text-white/35">Stock bajo hasta: {item.threshold}</span></span>
                    <span className={`rounded-full border px-3 py-1 text-xs font-black ${item.stock <= stockSettings.criticalStockThreshold ? "border-red-400/25 bg-red-400/10 text-red-300" : "border-amber-400/25 bg-amber-400/10 text-amber-200"}`}>Stock {item.stock}</span>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button type="button" onClick={() => onNavigate("productos")} className="inline-flex h-8 cursor-pointer items-center rounded-xl border border-beyonix-blue-light/18 bg-beyonix-blue/12 px-3 text-xs font-black text-white/70 transition hover:border-beyonix-sky/38 hover:text-white">Editar producto</button>
                    <button type="button" onClick={() => onNavigate("compras")} className="inline-flex h-8 cursor-pointer items-center rounded-xl border border-beyonix-sky/24 bg-beyonix-blue/20 px-3 text-xs font-black text-beyonix-sky transition hover:border-beyonix-sky/45 hover:bg-beyonix-blue/32">Registrar compra</button>
                  </div>
                </div>
              )) : <div className="md:col-span-2 xl:col-span-3"><EmptyState icon={<Package className="size-5" />} title="Stock saludable" description="No hay productos sin stock o bajo el umbral configurado." /></div>}
            </div>
          </section>
        </>
      ) : (
        <>          {!sensitive ? (
            <section className="rounded-2xl border border-white/8 bg-[#141414] p-5 text-center">
              <h2 className="text-2xl font-black text-white">Análisis comercial</h2>
              <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-white/55">
                Esta vista contiene facturación, ganancia y ticket promedio. Solo admin y super admin pueden verla.
              </p>
            </section>
          ) : (
            <>
              <section className="rounded-2xl border border-white/8 bg-[#141414] p-4">
                <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
                  <div>
                    <p className="mb-1 text-11px font-bold uppercase tracking-widest text-beyonix-cyan">
                      Análisis comercial
                    </p>
                    <h2 className="text-xl font-black text-white">
                      Métricas y ventas
                    </h2>
                  </div>
                  <button
                    type="button"
                    aria-label={hiddenValues ? "Mostrar valores" : "Ocultar valores"}
                    onClick={toggleHiddenValues}
                    className="inline-flex h-9 cursor-pointer items-center justify-center gap-2 rounded-xl border border-white/10 px-4 text-xs font-black text-white/72 transition hover:border-beyonix-sky/45 hover:text-white"
                  >
                    {hiddenValues ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
                    {hiddenValues ? "Mostrar valores" : "Ocultar valores"}
                  </button>
                </div>

                <div className="mt-3 rounded-2xl border border-white/8 bg-transparent p-3">
                  <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-admin-commercial-filters">
                    <FilterField label="Desde">
                      <AdminDatePicker
                        title="Desde"
                        ariaLabel="Desde"
                        value={from}
                        placeholder="Desde"
                        onChange={setFrom}
                      />
                    </FilterField>

                    <FilterField label="Hasta">
                      <AdminDatePicker
                        title="Hasta"
                        ariaLabel="Hasta"
                        value={to}
                        placeholder="Hasta"
                        onChange={setTo}
                      />
                    </FilterField>

                    <FilterField label="Mes">
                      <AdminSelect
                        title="Mes"
                        value={month}
                        onChange={setMonth}
                      >
                        {MONTHS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </AdminSelect>
                    </FilterField>

                    <FilterField label="Año">
                      <AdminSelect
                        title="Año"
                        ariaLabel="Año"
                        value={year}
                        onChange={setYear}
                      >
                        <option value="">Todos los años</option>
                        {(yearOptions.length
                          ? yearOptions
                          : [String(today.getFullYear())]
                        ).map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </AdminSelect>
                    </FilterField>

                    <FilterField label="Canal">
                      <AdminSelect
                        title="Canal"
                        value={channel}
                        onChange={(value) => setChannel(value as SalesChannel)}
                      >
                        <option value="todos">Todos los canales</option>
                        <option value="BEYONIX Web">BEYONIX Web</option>
                        <option value="MercadoLibre Marketplace">
                          MercadoLibre Marketplace
                        </option>
                        <option value="Ventas externas">Ventas externas</option>
                      </AdminSelect>
                    </FilterField>

                    <FilterField label="Producto">
                      <AdminSelect
                        title="Producto"
                        value={product}
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

                    <FilterField label="Categoría">
                      <AdminSelect
                        title="Categoría"
                        value={category}
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
                  </div>
                </div>
              </section>

              <section className="rounded-2xl border border-beyonix-blue-light/18 bg-[linear-gradient(145deg,rgba(7,16,24,0.88),rgba(3,7,13,0.96))] p-4">
                <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
                  <div>
                    <p className="text-11px font-bold uppercase tracking-widest text-beyonix-cyan">
                      Control financiero
                    </p>
                    <h2 className="mt-1 text-xl font-black text-white">
                      Caja y obligaciones
                    </h2>
                  </div>
                  <p className="text-right text-11px font-semibold text-white/38">
                    Corte: {formatDate(financialSummary.generatedAt)}<br />
                    {financialSummary.ordersScanned} web · {financialSummary.externalRowsScanned} externas · {financialSummary.marketplaceRowsScanned} ML
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-2 xl:grid-cols-3 2xl:grid-cols-6">
                  <FinancialMetric label="Ventas brutas" value={maskAmount(formatPrice(financialSummary.grossSales), hiddenValues)} detail="Web + externas + Mercado Libre" />
                  <FinancialMetric label="Ventas netas" value={maskAmount(formatPrice(financialSummary.netSales), hiddenValues)} detail="Luego de cargos, descuentos y reintegros" tone="positive" />
                  <FinancialMetric label="Cobros web" value={maskAmount(formatPrice(financialSummary.externalCollected), hiddenValues)} detail="Dinero cobrado por pasarelas" />
                  <FinancialMetric label="Saldo aplicado" value={maskAmount(formatPrice(financialSummary.customerCreditUsed), hiddenValues)} detail="Saldo interno usado" />
                  <FinancialMetric label="Reintegrado" value={maskAmount(formatPrice(financialSummary.completedRefunds), hiddenValues)} detail="Web + Mercado Libre" tone={financialSummary.completedRefunds > 0 ? "danger" : "neutral"} />
                  <FinancialMetric label="Facturado ARCA" value={maskAmount(formatPrice(financialSummary.invoicedAmount), hiddenValues)} detail={`${financialSummary.invoicedOrders} comprobantes`} />
                </div>

                <div className="mt-2 grid grid-cols-2 gap-2 xl:grid-cols-3 2xl:grid-cols-6">
                  <FinancialMetric label="Envíos cobrados" value={maskAmount(formatPrice(financialSummary.shippingCharged), hiddenValues)} detail="Cobrado al cliente" />
                  <FinancialMetric label="Costo logístico" value={maskAmount(formatPrice(financialSummary.shippingCost), hiddenValues)} detail="Web + externas + Mercado Libre" tone={financialSummary.shippingCost > 0 ? "warning" : "neutral"} />
                  <FinancialMetric label="Resultado envíos web" value={maskAmount(formatPrice(financialSummary.shippingBalance), hiddenValues)} detail="Cobrado menos costo web" tone={financialSummary.shippingBalance >= 0 ? "positive" : "danger"} />
                  <FinancialMetric label="Comisiones" value={maskAmount(formatPrice(financialSummary.salesFees), hiddenValues)} detail="Externas + Mercado Libre" tone={financialSummary.salesFees > 0 ? "warning" : "neutral"} />
                  <FinancialMetric label="Descuentos" value={maskAmount(formatPrice(financialSummary.transferDiscounts), hiddenValues)} detail="Transferencias" />
                  <FinancialMetric label="Resultado conocido" value={maskAmount(formatPrice(financialSummary.knownOperatingResult), hiddenValues)} detail="Antes de mercadería e impuestos" tone={financialSummary.knownOperatingResult >= 0 ? "positive" : "danger"} />
                </div>

                <div className="mt-2 grid grid-cols-2 gap-2 xl:grid-cols-3 2xl:grid-cols-6">
                  <FinancialMetric label="Compras mercadería" value={maskAmount(formatPrice(financialSummary.inventoryPurchases), hiddenValues)} detail="Capital comprado" />
                  <FinancialMetric label="Costo vendido" value={maskAmount(formatPrice(financialSummary.costOfGoodsSold), hiddenValues)} detail={`${financialSummary.costCoveragePercent.toFixed(1)}% cubierto`} />
                  <FinancialMetric label="Gastos pagados" value={maskAmount(formatPrice(financialSummary.operatingExpensesPaid), hiddenValues)} detail="Operación e impuestos" tone={financialSummary.operatingExpensesPaid > 0 ? "warning" : "neutral"} />
                  <FinancialMetric label="Gastos pendientes" value={maskAmount(formatPrice(financialSummary.operatingExpensesPending), hiddenValues)} detail="Obligaciones abiertas" tone={financialSummary.operatingExpensesPending > 0 ? "danger" : "neutral"} />
                  <FinancialMetric label="Ganancia real" value={financialSummary.trueProfit == null ? "Pendiente" : maskAmount(formatPrice(financialSummary.trueProfit), hiddenValues)} detail="Con costos y gastos" tone={financialSummary.trueProfit == null ? "warning" : financialSummary.trueProfit >= 0 ? "positive" : "danger"} />
                  <FinancialMetric label="Margen real" value={financialSummary.trueMarginPercent == null ? "Pendiente" : hiddenValues ? "****" : `${financialSummary.trueMarginPercent.toFixed(1)}%`} detail="Rentabilidad final" tone={financialSummary.trueMarginPercent == null ? "warning" : financialSummary.trueMarginPercent >= 0 ? "positive" : "danger"} />
                </div>

                <div className="mt-3 grid gap-2 lg:grid-cols-2">
                  {financialSummary.warnings.map((warning) => (
                    <div key={warning} className="flex items-start gap-2 rounded-xl border border-amber-400/18 bg-amber-400/7 px-3 py-2.5 text-xs font-semibold leading-5 text-amber-100/80">
                      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-300" />
                      <span>{warning}</span>
                    </div>
                  ))}
                </div>
              </section>

              <div className="grid gap-2.5 md:grid-cols-2 2xl:grid-cols-4">
                <StatCard title="Facturación diaria" value={maskAmount(formatPrice(commercialStats.facturacionDiaria), hiddenValues)} icon={<BarChart3 className="size-5" />} />
                <StatCard title="Facturación mensual" value={maskAmount(formatPrice(commercialStats.facturacionMensual), hiddenValues)} icon={<BarChart3 className="size-5" />} />
                <StatCard title="Facturación anual" value={maskAmount(formatPrice(commercialStats.facturacionAnual), hiddenValues)} icon={<BarChart3 className="size-5" />} />
                <StatCard title="Ticket promedio" value={maskAmount(formatPrice(ticket), hiddenValues)} icon={<CreditCard className="size-5" />} />
                <StatCard title="Cantidad de ventas" value={commercialStats.ventas} icon={<ShoppingCart className="size-5" />} />
                <StatCard title="Unidades vendidas" value={commercialStats.unidades} icon={<Package className="size-5" />} />
                <StatCard title="Reintegro pendiente" value={maskAmount(formatPrice(financialSummary.pendingRefunds), hiddenValues)} helper={`${stats.reintegrosPendientes} operaciones`} icon={<RotateCcw className="size-5" />} />
                <StatCard title="Cobertura ARCA" value={`${invoiceCoverage.toFixed(1)}%`} helper={`${financialSummary.ordersWithoutInvoice} pedidos sin factura`} icon={<ReceiptText className="size-5" />} />
              </div>

              <EnhancedMiniLineChart
                rows={evolutionSales}
                channelRows={byChannel}
                hidden={hiddenValues}
              />

              <div className="grid gap-3 xl:grid-cols-2">
                <section className="rounded-2xl border border-white/8 bg-[#141414] p-4 xl:col-span-2">
                  <SectionHeader eyebrow="Productos" title="Más vendidos" />
                  <BarList rows={byProduct} valueKey="value" />
                </section>
              </div>

              <section className="rounded-2xl border border-white/8 bg-[#141414] p-4">
                <SectionHeader eyebrow="Tabla" title="Detalle comercial" />
                <div className="overflow-x-auto rounded-2xl border border-white/7 bg-black">
                  <table className="min-w-980px w-full text-left text-sm">
                    <thead className="text-11px uppercase tracking-widest text-white/45">
                      <tr>
                        {[
                          ["productName", "Producto"],
                          ["channel", "Canal"],
                          ["paymentMethod", "Método pago"],
                          ["quantity", "Cantidad vendida"],
                          ["grossAmount", "Facturación"],
                          ["costAmount", "Costo mercadería"],
                          ["profitAmount", "Resultado bruto"],
                          ["marginPercent", "Margen bruto %"],
                          ["ticket", "Ticket promedio"],
                        ].map(([key, label]) => (
                          <th
                            key={key}
                            className={`px-4 py-3 ${
                              key === "productName" || key === "channel"
                                ? "text-left"
                                : "text-center"
                            }`}
                          >
                            <button
                              type="button"
                              onClick={() => setSortKey(key as SortKey)}
                              className="cursor-pointer font-black text-white/55 transition hover:text-white"
                            >
                              {label}
                            </button>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {tableRows.slice(0, 80).map((sale) => {
                        const rowTicket = sale.quantity ? sale.grossAmount / sale.quantity : 0
                        return (
                          <tr key={sale.id} className="border-t border-white/6">
                            <td className="px-4 py-3 font-bold text-white">{sale.productName}</td>
                            <td className="px-4 py-3 text-white/62">{sale.channel}</td>
                            <td className="px-4 py-3 text-center text-white/62">{sale.paymentMethod}</td>
                            <td className="px-4 py-3 text-center text-white/62">{sale.quantity}</td>
                            <td className="px-4 py-3 text-center text-white/62">{maskAmount(formatPrice(sale.grossAmount), hiddenValues)}</td>
                            <td className="px-4 py-3 text-center text-white/62">{sale.costAmount == null ? "-" : maskAmount(formatPrice(sale.costAmount), hiddenValues)}</td>
                            <td className="px-4 py-3 text-center text-white/62">{sale.profitAmount == null ? "-" : maskAmount(formatPrice(sale.profitAmount), hiddenValues)}</td>
                            <td className="px-4 py-3 text-center text-white/62">{sale.marginPercent == null || hiddenValues ? (hiddenValues ? "****" : "-") : `${sale.marginPercent.toFixed(1)}%`}</td>
                            <td className="px-4 py-3 text-center text-white/62">{maskAmount(formatPrice(rowTicket), hiddenValues)}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                  {!tableRows.length && (
                    <p className="px-4 py-8 text-center text-sm text-white/45">
                      No hay ventas para los filtros seleccionados.
                    </p>
                  )}
                </div>
              </section>
            </>
          )}
        </>
      )}
    </div>
  )
}
