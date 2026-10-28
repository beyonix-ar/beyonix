"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import dynamic from "next/dynamic"
import { useRouter, useSearchParams } from "next/navigation"
import {
  ArrowRight,
  BarChart3,
  CheckCircle2,
  Clock,
  CreditCard,
  FileUp,
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
  type LucideIcon,
} from "lucide-react"

import {
  type DashboardSearchItem,
  type DashboardRecentActivity,
} from "@/lib/supabase/queries/dashboard"
import { useDashboard } from "@/hooks/use-dashboard"
import { useSystemHealth } from "@/hooks/use-system-health"
import type { IntegrationHealthView } from "@/lib/admin/system-health"
import { getAdminCapabilities } from "@/lib/admin/admin-capabilities"
import { useSiteSettings } from "@/hooks/use-site-settings"
import {
  AdminEmptyState,
  AdminSkeleton,
} from "../../components/admin-controls"
import { AdminHelpTip } from "../../components/admin-help-tip"
import {
  ADMIN_ROUTES,
  type AdminRouteKey,
} from "@/lib/admin/admin-routes"
import { useAdminNotificationGroups } from "@/context/admin-notifications-context"
import { DashboardSectionHeader, FinancialMetric } from "./dashboard-ui"

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
const AdminExternalSales = dynamic(
  () => import("./admin-external-sales").then((module) => module.AdminExternalSales),
  { loading: DashboardPanelLoading, ssr: false },
)
const AdminMercadoLibreSales = dynamic(
  () =>
    import("./admin-mercadolibre-sales").then(
      (module) => module.AdminMercadoLibreSales,
    ),
  { loading: DashboardPanelLoading, ssr: false },
)
const DashboardCommercialView = dynamic(
  () =>
    import("./dashboard-commercial").then(
      (module) => module.DashboardCommercialView,
    ),
  { loading: DashboardPanelLoading, ssr: false },
)

type DashboardTab = "operativo" | "comercial" | "externas" | "ml" | "costos"

const DASHBOARD_TABS: DashboardTab[] = ["operativo", "comercial", "externas", "ml", "costos"]

function isDashboardTab(value: string | null): value is DashboardTab {
  return DASHBOARD_TABS.some((tab) => tab === value)
}

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

function SystemStatusPill({ item }: { item: IntegrationHealthView }) {
  const tone =
    item.status === "ok"
      ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-200"
      : item.status === "error"
        ? "border-red-400/25 bg-red-400/10 text-red-200"
        : item.status === "warning"
          ? "border-amber-400/25 bg-amber-400/10 text-amber-200"
          : item.status === "disabled"
            ? "border-slate-400/20 bg-slate-400/8 text-slate-300"
          : "border-white/10 bg-white/5 text-white/52"

  return (
    <div
      className="rounded-xl border border-beyonix-blue-light/14 bg-[rgba(3,7,13,0.72)] px-3 py-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.025)]"
      data-integration={item.id}
      data-status={item.status}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-black text-white">{item.label}</p>
          <p className="mt-1 line-clamp-2 text-11px leading-4 text-white/45" title={item.detail}>
            {item.detail}
          </p>
          {item.checkedAt && (
            <p className="mt-1 text-9px font-bold uppercase tracking-wide text-white/28">
              {item.latencyMs != null ? `${item.latencyMs} ms · ` : ""}
              {formatRelativeTime(item.checkedAt)}
              {item.lastAttemptFailed ? " · Último intento falló" : ""}
            </p>
          )}
        </div>
        <span className={`shrink-0 rounded-full border px-2 py-0.5 text-9px font-black uppercase tracking-widest ${tone}`}>
          {item.badge}
        </span>
      </div>
    </div>
  )
}

function Skeleton() {
  return <AdminSkeleton rows={7} className="p-4 sm:p-6 lg:p-8" />
}

interface UrgentAction {
  key: string
  title: string
  value: number
  helper: string
  help: string
  cta: string
  icon: LucideIcon
  route: AdminRouteKey
}

function UrgentActionCard({
  action,
  onNavigate,
}: {
  action: UrgentAction
  onNavigate: (section: AdminRouteKey) => void
}) {
  const Icon = action.icon
  const pending = action.value > 0

  return (
    <div className="admin-dash-action" data-state={pending ? "attention" : "clear"}>
      <div className="flex items-start justify-between gap-2">
        <p className="flex min-w-0 items-center gap-1 text-11px font-black uppercase tracking-widest text-white/62">
          <span className="truncate">{action.title}</span>
          <AdminHelpTip label={action.title} text={action.help} />
        </p>
        <span className="admin-dash-action-icon" aria-hidden="true">
          <Icon className="size-4" />
        </span>
      </div>
      <p className="admin-dash-action-value">{action.value.toLocaleString("es-AR")}</p>
      <p className="min-h-4 truncate text-xs text-white/55">
        {pending ? action.helper : "Al día"}
      </p>
      <button
        type="button"
        aria-label={`${action.title}: ${action.cta.toLocaleLowerCase("es")}`}
        onClick={() => onNavigate(action.route)}
        className="admin-dash-action-cta"
      >
        {action.cta}
        <ArrowRight className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  )
}

function ControlIndicator({
  label,
  help,
  value,
  onClick,
}: {
  label: string
  help: string
  value: number
  onClick: () => void
}) {
  const healthy = value === 0

  return (
    <div className="admin-dash-control" data-state={healthy ? "ok" : "alert"}>
      <span className="flex min-w-0 items-center gap-1 text-xs font-bold text-white/75">
        {healthy ? (
          <CheckCircle2 className="size-4 shrink-0 text-emerald-300" aria-hidden="true" />
        ) : (
          <ShieldAlert className="size-4 shrink-0 text-red-300" aria-hidden="true" />
        )}
        <span className="truncate">{label}</span>
        <AdminHelpTip label={label} text={help} />
      </span>
      <button
        type="button"
        onClick={onClick}
        aria-label={`${label}: ${value}. Abrir`}
        className="admin-dash-control-value"
      >
        {healthy ? "OK" : value}
        {!healthy && <ArrowRight className="size-3.5" aria-hidden="true" />}
      </button>
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
    searchIndex,
    loading,
    error,
    reloadDashboard,
  } = useDashboard()
  const {
    state: systemHealth,
    items: systemStatus,
    refreshing: healthRefreshing,
    refreshNow: refreshSystemHealth,
  } = useSystemHealth()
  const healthUpdatedAt = systemHealth.lastUpdatedAt
  const requestedTab = searchParams.get("tab")
  const [tab, setTab] = useState<DashboardTab>(
    isDashboardTab(requestedTab) ? requestedTab : "operativo",
  )

  useEffect(() => {
    if (isDashboardTab(requestedTab)) setTab(requestedTab)
  }, [requestedTab])

  if (loading) return <Skeleton />
  if (error && (!stats || !financialSummary)) {
    return (
      <div className="rounded-2xl border border-red-400/25 bg-red-400/10 p-8 text-center text-red-100">
        <p className="text-base font-black">No se pudo cargar el dashboard.</p>
        <p className="mt-2 text-sm text-red-100/70">Los importes no están disponibles; no se muestran valores en cero.</p>
        <button
          type="button"
          onClick={() => void reloadDashboard()}
          className="mt-5 inline-flex h-10 cursor-pointer items-center gap-2 rounded-xl border border-red-300/30 px-4 text-xs font-black"
        >
          <RefreshCw className="size-4" /> Reintentar
        </button>
      </div>
    )
  }
  if (!stats || !financialSummary) return null
  const capabilities = getAdminCapabilities(role)
  const sensitive = capabilities.canManageFinancials
  const canViewAudit = capabilities.canViewAudit

  const urgentActions: UrgentAction[] = [
    {
      key: "payments",
      title: "Pagos en revisión",
      value: stats.pagosEnRevision,
      helper: `${stats.esperandoComprobante} esperan comprobante`,
      help: "Pedidos con un pago informado que todavía necesita validación manual antes de avanzar.",
      cta: "Revisar pagos",
      icon: CreditCard,
      route: "pedidos",
    },
    {
      key: "dispatch",
      title: "Pedidos a preparar",
      value: stats.enviosPendientes,
      helper: `${stats.pedidosSinTracking} sin tracking o etiqueta`,
      help: "Pedidos pagos que todavía no salieron: falta preparar, etiquetar o despachar.",
      cta: "Ver pedidos",
      icon: ShoppingCart,
      route: "pedidos",
    },
    {
      key: "refunds",
      title: "Reintegros pendientes",
      value: stats.reintegrosPendientes,
      helper: "Dinero por devolver a clientes",
      help: "Pedidos con un reintegro aprobado que todavía no se completó.",
      cta: "Ver reintegros",
      icon: RotateCcw,
      route: "pedidos",
    },
    {
      key: "invoice-errors",
      title: "Facturas con error",
      value: stats.facturasConError,
      helper: "Requieren corrección",
      help: "Facturas cuya emisión falló. Hay que corregir el dato y volver a emitir.",
      cta: "Corregir",
      icon: ShieldAlert,
      route: "facturacion",
    },
    {
      key: "credit-notes",
      title: "Notas de crédito",
      value: stats.notasCreditoPendientes,
      helper: "Pendientes de autorizar",
      help: "Notas de crédito requeridas (por cancelación o reintegro) que todavía no están autorizadas.",
      cta: "Autorizar",
      icon: ReceiptText,
      route: "facturacion",
    },
    {
      key: "invoices",
      title: "Facturas pendientes",
      value: stats.facturasPendientes,
      helper: "Pedidos pagos sin factura emitida",
      help: "Pedidos pagos que todavía no tienen factura autorizada.",
      cta: "Facturar",
      icon: FileUp,
      route: "facturacion",
    },
  ]
  const pendingFronts = urgentActions.filter((action) => action.value > 0).length
  const tabs: { key: DashboardTab; label: string; icon: LucideIcon }[] = [
    { key: "operativo", label: "Centro operativo", icon: ShoppingCart },
    { key: "comercial", label: "Análisis comercial", icon: BarChart3 },
    ...(sensitive
      ? [
          { key: "externas" as const, label: "Ventas externas", icon: Store },
          { key: "ml" as const, label: "Ventas ML", icon: Tags },
          { key: "costos" as const, label: "Compras", icon: Package },
        ]
      : []),
  ]

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
              Lo urgente primero. Las ventas, compras y registros por canal están en sus pestañas.
            </p>
          </div>
          <div className="admin-dashboard-tabs-scroll min-w-0 max-w-full overflow-x-auto">
            <div role="tablist" aria-label="Secciones del dashboard" className="admin-dashboard-tabs inline-flex min-w-max flex-nowrap rounded-xl border border-beyonix-blue-light/24 bg-black/30 p-1 shadow-inner shadow-black/40">
              {tabs.map(({ key, label, icon: Icon }) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={tab === key}
                  onClick={() => setTab(key)}
                  className={`inline-flex h-8 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-lg border px-3 text-xs font-black transition-all ${
                    tab === key
                      ? "border-beyonix-sky/36 bg-beyonix-blue/70 text-white shadow-[0_0_10px_rgba(96,165,250,0.10)]"
                      : "border-transparent text-white/62 hover:border-beyonix-blue-light/20 hover:bg-beyonix-blue/18 hover:text-white"
                  }`}
                >
                  <Icon className="size-3.5" />
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
        <AdminExternalSales />
      ) : tab === "ml" ? (
        <AdminMercadoLibreSales />
      ) : tab === "operativo" ? (
        <>
          <section className="admin-dashboard-priorities rounded-2xl border p-3.5 sm:p-4" aria-labelledby="urgent-actions-title">
            <div className="mb-3 flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
              <DashboardSectionHeader
                id="urgent-actions-title"
                eyebrow="Centro operativo"
                title="Acciones urgentes"
                description={
                  pendingFronts === 0
                    ? "Todo al día: no hay tareas pendientes."
                    : `${pendingFronts} de ${urgentActions.length} frentes necesitan atención.`
                }
              />
              <GlobalAdminSearch rows={searchIndex} onNavigate={onNavigate} />
            </div>
            <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
              {urgentActions.map((action) => (
                <UrgentActionCard key={action.key} action={action} onNavigate={onNavigate} />
              ))}
            </div>
          </section>

          <div className={`grid gap-4 ${sensitive ? "xl:grid-cols-2" : ""}`}>
            {sensitive && (
              <section className="rounded-2xl border p-4" aria-labelledby="reconciliation-title">
                <DashboardSectionHeader
                  id="reconciliation-title"
                  eyebrow="Alertas"
                  title="Conciliación"
                  help="Controles automáticos sobre pedidos pagos. Si un valor no es 0, hay datos que revisar antes de confiar en los números."
                  description={
                    financialSummary.complete
                      ? `${financialSummary.ordersScanned} pedidos verificados`
                      : "Lectura incompleta: los controles pueden no estar al día"
                  }
                />
                <div className="grid gap-2">
                  <ControlIndicator
                    label="Cobros distintos al esperado"
                    help="Pedidos cuyo cobro confirmado no coincide con el importe que se esperaba cobrar."
                    value={financialSummary.ordersWithPaymentMismatch}
                    onClick={() => onNavigate("pedidos")}
                  />
                  <ControlIndicator
                    label="Envíos sin costo cargado"
                    help="Pedidos con envío asignado que todavía no tienen el costo real del proveedor."
                    value={financialSummary.ordersMissingShippingCost}
                    onClick={() => onNavigate("pedidos")}
                  />
                  <ControlIndicator
                    label="Stock negativo"
                    help="Productos o variantes con stock menor a cero. Suele indicar una venta sin compra registrada."
                    value={financialSummary.negativeStockItems}
                    onClick={() => onNavigate("productos")}
                  />
                </div>
              </section>
            )}

            <section className="rounded-2xl border p-4" aria-labelledby="system-status-title">
              <DashboardSectionHeader
                id="system-status-title"
                eyebrow="Sistema"
                title="Estado de integraciones"
                description="Comprobación real cada 60 segundos (solo lectura)"
                action={
                  <div className="flex items-center gap-2">
                    {healthUpdatedAt && (
                      <span className="hidden text-right text-9px font-bold uppercase tracking-wide text-white/40 sm:block">
                        Última actualización del panel
                        <span className="block text-white/55">
                          {formatRelativeTime(healthUpdatedAt)}
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
                }
              />
              {systemHealth.lastAttemptError && (
                <p className="mb-2 rounded-lg border border-red-400/20 bg-red-400/8 px-3 py-2 text-10px font-semibold text-red-200" role="status">
                  El último intento falló: {systemHealth.lastAttemptError} Se muestran los últimos resultados válidos.
                </p>
              )}
              <div className={`grid gap-2 sm:grid-cols-2 ${sensitive ? "" : "xl:grid-cols-4"}`}>
                {systemStatus.map((item) => (
                  <SystemStatusPill key={item.id} item={item} />
                ))}
              </div>
            </section>
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <section className="rounded-2xl border p-4" aria-labelledby="recent-orders-title">
              <DashboardSectionHeader
                id="recent-orders-title"
                eyebrow="Operación"
                title="Últimos pedidos"
                action={
                  <button type="button" onClick={() => onNavigate("pedidos")} className="admin-ds-button admin-ds-button-secondary inline-flex cursor-pointer items-center gap-2 px-3 text-xs font-black transition">
                    Ver pedidos <ArrowRight className="size-3.5" />
                  </button>
                }
              />
              <div className="custom-scrollbar max-h-360px space-y-2 overflow-y-auto pr-1">
                {recentOrders.length ? recentOrders.map((order) => (
                  <button type="button" aria-label={`Abrir pedido ${order.id}`} key={order.id} onClick={() => router.push(`/admin/pedidos/${encodeURIComponent(String(order.id))}`)} className="flex w-full cursor-pointer items-center justify-between gap-4 rounded-2xl border border-beyonix-blue-light/14 bg-[rgba(3,7,13,0.72)] px-4 py-3 text-left transition hover:border-beyonix-sky/35 hover:bg-beyonix-blue/20">
                    <span className="min-w-0"><span className="block text-sm font-bold text-white">Pedido #{order.id}</span><span className="mt-1 block truncate text-xs text-white/50">{order.cliente_nombre || order.cliente_email || "Cliente"}</span></span>
                    <span className="text-right"><span className="block text-sm font-black text-white">{order.estado}</span><span className="mt-1 block text-11px uppercase text-white/45">{formatRelativeTime(order.created_at)}</span></span>
                  </button>
                )) : <EmptyState icon={<ShoppingCart className="size-5" />} title="No hay pedidos todavía" description="Cuando ingresen compras, van a aparecer acá." />}
              </div>
            </section>
            <section className="rounded-2xl border p-4" aria-labelledby="recent-activity-title">
              <DashboardSectionHeader id="recent-activity-title" eyebrow="Actividad" title="Actividad reciente" action={canViewAudit ? <button type="button" onClick={() => onNavigate("auditoria")} className="admin-ds-button admin-ds-button-secondary inline-flex cursor-pointer items-center gap-2 px-3 text-xs font-black transition">Ver auditoría <ArrowRight className="size-3.5" /></button> : undefined} />
              <div className="custom-scrollbar max-h-360px space-y-2 overflow-y-auto pr-1">
                {recentActivity.length ? recentActivity.map((item) => <ActivityItem key={item.id} item={item} />) : <EmptyState icon={<Clock className="size-5" />} title="No hay actividad reciente" description="Los movimientos operativos se mostrarán en este panel." />}
              </div>
            </section>
          </div>

          <section className="rounded-2xl border p-4" aria-labelledby="low-stock-title">
            <DashboardSectionHeader
              id="low-stock-title"
              eyebrow="Stock"
              title="Sin stock o bajo stock"
              help="Productos y variantes en o debajo del umbral de stock bajo configurado. En rojo, los que llegaron al umbral crítico."
              description={lowStock.length ? `${lowStock.length} ${lowStock.length === 1 ? "artículo" : "artículos"} para reponer` : undefined}
              action={<button type="button" aria-label="Ver productos" onClick={() => onNavigate("productos")} className="admin-ds-button admin-ds-button-secondary inline-flex cursor-pointer items-center gap-2 px-3 text-xs font-black transition">Ver productos <ArrowRight className="size-3.5" /></button>}
            />
            <div className="custom-scrollbar grid max-h-420px gap-2.5 overflow-y-auto pr-1 md:grid-cols-2 xl:grid-cols-3">
              {lowStock.length ? lowStock.map((item) => (
                <div key={item.id} className="rounded-2xl border border-beyonix-blue-light/14 bg-[rgba(3,7,13,0.72)] px-4 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.025)]">
                  <div className="flex items-start justify-between gap-3">
                    <span className="min-w-0"><span className="block truncate text-sm font-bold text-white">{item.producto_nombre || item.nombre}</span><span className="mt-1 flex items-center gap-2 truncate text-xs text-white/50">{item.color_hex && <span className="size-3 rounded-full border border-white/20" style={{ backgroundColor: item.color_hex }} />}{item.tipo === "variante" ? item.nombre : "Producto"}</span><span className="mt-2 block text-11px font-bold uppercase tracking-widest text-white/40">Stock bajo hasta: {item.threshold}</span></span>
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

          <section className="rounded-2xl border p-4" aria-labelledby="business-status-title">
            <DashboardSectionHeader
              id="business-status-title"
              eyebrow="Histórico"
              title="Estado del negocio"
              description="Totales acumulados, como contexto. No requieren acción."
            />
            <div className="admin-dash-metric-grid">
              <FinancialMetric label="Pedidos totales" value={stats.totalOrdenes.toLocaleString("es-AR")} detail="Desde el inicio" />
              <FinancialMetric label="Pedidos pagos" value={stats.pedidosPagados.toLocaleString("es-AR")} detail="Cobro confirmado" tone="positive" />
              <FinancialMetric label="Pedidos pendientes" value={stats.pedidosPendientes.toLocaleString("es-AR")} detail="En estado “pendiente”" tone={stats.pedidosPendientes > 0 ? "warning" : "neutral"} help="Pedidos visibles en el panel que siguen en estado “pendiente”: todavía no avanzaron a pago confirmado ni a preparación." />
              <FinancialMetric label="Cancelados" value={stats.pedidosCancelados.toLocaleString("es-AR")} detail="Desde el inicio" />
              <FinancialMetric label="Clientes" value={stats.totalClientes == null ? "—" : stats.totalClientes.toLocaleString("es-AR")} detail="Cuentas de cliente" />
              <FinancialMetric label="Productos activos" value={stats.productosActivos.toLocaleString("es-AR")} detail={`${stats.productosBajoStock} con stock bajo`} tone={stats.productosBajoStock > 0 ? "warning" : "positive"} />
            </div>
          </section>
        </>
      ) : !sensitive ? (
        <section className="rounded-2xl border p-5 text-center">
          <h2 className="text-2xl font-black text-white">Análisis comercial</h2>
          <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-white/55">
            Esta vista contiene facturación, ganancia y ticket promedio. Solo admin y super admin pueden verla.
          </p>
        </section>
      ) : (
        <DashboardCommercialView
          sales={commercialSales}
          financialSummary={financialSummary}
          pendingRefundOperations={stats.reintegrosPendientes}
        />
      )}
    </div>
  )
}
