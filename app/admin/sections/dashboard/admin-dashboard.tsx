"use client"

import { useMemo, useRef, useState } from "react"
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  Clock,
  CreditCard,
  Eye,
  EyeOff,
  FileUp,
  Package,
  RefreshCw,
  ShoppingCart,
  Truck,
} from "lucide-react"
import * as XLSX from "xlsx"

import type { AdminSection } from "../../admin-client"
import { supabase } from "@/lib/supabase/client"
import {
  type DashboardCommercialSale,
  type DashboardRecentActivity,
} from "@/lib/supabase/queries/dashboard"
import { useDashboard } from "@/hooks/use-dashboard"
import { formatPrice } from "../productos/helpers"
import { SITE_SETTINGS } from "@/config/site-settings"
import { AdminDatePicker } from "../../components/admin-date-picker"
import { AdminSelect } from "../../components/admin-controls"

interface AdminDashboardProps {
  onNavigate: (section: AdminSection) => void
}

type DashboardTab = "operativo" | "comercial"
type SalesChannel = "todos" | "BEYONIX Web" | "MercadoLibre Marketplace"
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

interface ImportedSale {
  sale_date: string | null
  operation_id: string | null
  order_id: string | null
  product_name: string
  sku: string | null
  quantity: number
  gross_amount: number
  fee_amount: number | null
  shipping_amount: number | null
  net_amount: number | null
  raw_data: Record<string, unknown>
}

const HIDDEN_AMOUNT = "$••••••"
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

function normalizeKey(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

function pickValue(row: Record<string, unknown>, aliases: string[]) {
  const byKey = new Map(
    Object.keys(row).map((key) => [normalizeKey(key), row[key]])
  )

  for (const alias of aliases) {
    const direct = byKey.get(normalizeKey(alias))
    if (direct != null && String(direct).trim() !== "") return direct
  }

  for (const [key, value] of byKey) {
    if (aliases.some((alias) => key.includes(normalizeKey(alias)))) {
      if (value != null && String(value).trim() !== "") return value
    }
  }

  return null
}

function toNumber(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (value == null) return null

  const normalized = String(value)
    .replace(/\$/g, "")
    .replace(/\s/g, "")
    .replace(/\./g, "")
    .replace(",", ".")
  const number = Number(normalized)
  return Number.isFinite(number) ? number : null
}

function toDateString(value: unknown) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString()
  }
  if (typeof value === "number") {
    const parsed = XLSX.SSF.parse_date_code(value)
    if (parsed) {
      return new Date(
        parsed.y,
        parsed.m - 1,
        parsed.d,
        parsed.H,
        parsed.M,
        Math.floor(parsed.S)
      ).toISOString()
    }
  }
  if (value) {
    const parsed = new Date(String(value))
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString()
  }
  return null
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
    <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
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
      <span className="mb-2 block text-center text-10px font-black uppercase tracking-widest text-white/42">
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
  const content = (
    <>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-11px font-bold uppercase tracking-widest text-white/45">
            {title}
          </p>
          <p className="mt-3 truncate text-3xl font-black text-white">{value}</p>
          {helper && <p className="mt-2 text-xs text-white/50">{helper}</p>}
        </div>
        <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl border border-white/8 bg-black/25 text-beyonix-sky">
          {icon}
        </span>
      </div>
      {onClick && (
        <span className="mt-5 inline-flex items-center gap-2 text-xs font-bold text-beyonix-sky">
          Abrir <ArrowRight className="size-3.5" />
        </span>
      )}
    </>
  )

  if (onClick) {
    return (
      <button
        type="button"
        title={`Abrir ${title}`}
        aria-label={`Abrir ${title}`}
        onClick={onClick}
        className="min-h-140px cursor-pointer rounded-3xl border border-white/8 bg-black/85 p-5 text-left transition hover:-translate-y-0.5 hover:border-beyonix-sky/50"
      >
        {content}
      </button>
    )
  }

  return (
    <div className="min-h-140px rounded-3xl border border-white/8 bg-black/85 p-5">
      {content}
    </div>
  )
}

function Skeleton() {
  return (
    <div className="space-y-6 p-4 sm:p-6 lg:p-8">
      <div className="h-32 animate-pulse rounded-3xl border border-white/7 bg-white/3" />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div
            key={index}
            className="h-140px animate-pulse rounded-3xl border border-white/7 bg-white/3"
          />
        ))}
      </div>
      <div className="grid gap-6 xl:grid-cols-2">
        <div className="h-320px animate-pulse rounded-3xl border border-white/7 bg-white/3" />
        <div className="h-320px animate-pulse rounded-3xl border border-white/7 bg-white/3" />
      </div>
    </div>
  )
}

function MiniLineChart({
  rows,
  hidden,
}: {
  rows: DashboardCommercialSale[]
  hidden: boolean
}) {
  const points = useMemo(() => {
    const byDate = new Map<string, number>()
    rows.forEach((row) => {
      const key = row.date.slice(0, 10)
      byDate.set(key, (byDate.get(key) ?? 0) + row.grossAmount)
    })
    return [...byDate.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-24)
  }, [rows])
  const max = Math.max(...points.map(([, value]) => value), 1)
  const path = points
    .map(([_, value], index) => {
      const x = points.length <= 1 ? 0 : (index / (points.length - 1)) * 100
      const y = 100 - (value / max) * 86 - 7
      return `${index === 0 ? "M" : "L"} ${x} ${y}`
    })
    .join(" ")

  return (
    <div className="h-56 rounded-3xl border border-white/7 bg-black p-4">
      {points.length ? (
        <>
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-40 w-full">
            <path d={path} fill="none" stroke="#38bdf8" strokeWidth="2.4" />
          </svg>
          <div className="mt-3 flex items-center justify-between text-xs text-white/45">
            <span>{points[0]?.[0]}</span>
            <span className="font-bold text-white/70">
              {hidden ? HIDDEN_AMOUNT : formatPrice(max)}
            </span>
            <span>{points.at(-1)?.[0]}</span>
          </div>
        </>
      ) : (
        <p className="flex h-full items-center justify-center text-sm text-white/45">
          No hay datos para graficar.
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

function parseMercadoLibreRows(rows: Record<string, unknown>[]) {
  const warnings = new Set<string>()
  const parsed = rows
    .map<ImportedSale | null>((row) => {
      const date = toDateString(
        pickValue(row, ["Fecha", "Fecha de venta", "Fecha operación"])
      )
      const product =
        pickValue(row, ["Producto", "Publicación", "Título", "Item"]) ?? ""
      const quantity = toNumber(pickValue(row, ["Cantidad", "Unidades"])) ?? 1
      const unitPrice = toNumber(
        pickValue(row, ["Precio unitario", "Precio"])
      )
      const gross =
        toNumber(
          pickValue(row, ["Precio total", "Total", "Importe", "Monto"])
        ) ??
        (unitPrice !== null ? unitPrice * quantity : 0)
      const fee = toNumber(
        pickValue(row, ["Cargo por venta", "Comisión", "Comision"])
      )
      const shipping = toNumber(pickValue(row, ["Envío", "Envio"]))
      const net = toNumber(
        pickValue(row, ["Total recibido", "Neto recibido", "Dinero recibido"])
      )

      if (!date) warnings.add("No se detectó fecha en algunas filas.")
      if (!product) warnings.add("No se detectó producto en algunas filas.")
      if (!gross) warnings.add("No se detectó importe total en algunas filas.")

      if (!product && !gross) return null

      return {
        sale_date: date,
        operation_id:
          String(pickValue(row, ["Operación", "Operacion"]) ?? "") || null,
        order_id:
          String(pickValue(row, ["Número de venta", "Venta", "Orden"]) ?? "") ||
          null,
        product_name: String(product || "Venta MercadoLibre"),
        sku: String(pickValue(row, ["SKU", "Código", "Codigo"]) ?? "") || null,
        quantity: Math.max(1, Math.trunc(quantity)),
        gross_amount: gross,
        fee_amount: fee,
        shipping_amount: shipping,
        net_amount: net,
        raw_data: row,
      }
    })
    .filter(Boolean) as ImportedSale[]

  return {
    rows: parsed,
    warnings: [...warnings],
  }
}

function MercadoLibreImporter({ onImported }: { onImported: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [fileName, setFileName] = useState("")
  const [rows, setRows] = useState<ImportedSale[]>([])
  const [warnings, setWarnings] = useState<string[]>([])
  const [error, setError] = useState("")
  const [saving, setSaving] = useState(false)

  const handleFile = async (file: File) => {
    setError("")
    setRows([])
    setWarnings([])
    setFileName(file.name)

    try {
      const buffer = await file.arrayBuffer()
      const workbook = XLSX.read(buffer, { type: "array", cellDates: true })
      const sheet = workbook.Sheets[workbook.SheetNames[0]]
      const jsonRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
        defval: "",
      })
      const result = parseMercadoLibreRows(jsonRows)

      if (!result.rows.length) {
        setError("No se detectaron ventas importables en el archivo.")
        return
      }

      setRows(result.rows)
      setWarnings(result.warnings)
    } catch {
      setError("No se pudo leer el archivo. Revisá que sea .xlsx o .csv válido.")
    }
  }

  const confirmImport = async () => {
    setSaving(true)
    setError("")

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()

      const response = await fetch("/api/admin/mercadolibre-sales/import", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session?.access_token ?? ""}`,
        },
        body: JSON.stringify({
          sourceFileName: fileName,
          rows,
        }),
      })
      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || "No se pudo importar el archivo.")
      }

      setRows([])
      setWarnings([])
      setFileName("")
      onImported()
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo importar.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="rounded-3xl border border-white/8 bg-[#141414] p-5">
      <SectionHeader
        eyebrow="MercadoLibre"
        title="Importar ventas"
        action={
          <>
            <input
              ref={inputRef}
              type="file"
              accept=".xlsx,.csv"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) void handleFile(file)
              }}
            />
            <button
              type="button"
              title="Importar ventas MercadoLibre"
              aria-label="Importar ventas MercadoLibre"
              onClick={() => inputRef.current?.click()}
              className="inline-flex h-11 cursor-pointer items-center justify-center gap-2 rounded-2xl bg-white px-5 text-sm font-black text-black transition hover:-translate-y-0.5 hover:bg-white/90"
            >
              <FileUp className="size-4" />
              Importar ventas MercadoLibre
            </button>
          </>
        }
      />

      {error && (
        <p className="rounded-2xl border border-red-400/20 bg-red-400/10 px-4 py-3 text-sm text-red-200">
          {error}
        </p>
      )}

      {warnings.length > 0 && (
        <div className="space-y-1 rounded-2xl border border-amber-400/20 bg-amber-400/10 px-4 py-3 text-sm text-amber-100">
          {warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </div>
      )}

      {rows.length > 0 && (
        <div className="mt-4 space-y-4">
          <p className="text-sm text-white/58">
            Previsualización de {rows.length} ventas desde {fileName}.
          </p>
          <div className="overflow-x-auto rounded-2xl border border-white/7 bg-black">
            <table className="min-w-720px w-full text-left text-sm">
              <thead className="text-11px uppercase tracking-widest text-white/45">
                <tr>
                  {["Fecha", "Producto", "SKU", "Cantidad", "Total", "Neto"].map(
                    (header) => (
                      <th key={header} className="px-4 py-3 font-black">
                        {header}
                      </th>
                    )
                  )}
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 6).map((row, index) => (
                  <tr key={`${row.product_name}-${index}`} className="border-t border-white/6">
                    <td className="px-4 py-3 text-white/60">
                      {row.sale_date ? formatDate(row.sale_date) : "Sin fecha"}
                    </td>
                    <td className="px-4 py-3 font-bold text-white">
                      {row.product_name}
                    </td>
                    <td className="px-4 py-3 text-white/60">{row.sku || "-"}</td>
                    <td className="px-4 py-3 text-white/60">{row.quantity}</td>
                    <td className="px-4 py-3 text-white/60">
                      {formatPrice(row.gross_amount)}
                    </td>
                    <td className="px-4 py-3 text-white/60">
                      {row.net_amount != null ? formatPrice(row.net_amount) : "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button
            type="button"
            title="Confirmar importación"
            aria-label="Confirmar importación"
            disabled={saving}
            onClick={() => void confirmImport()}
            className="inline-flex h-11 cursor-pointer items-center justify-center gap-2 rounded-2xl bg-beyonix-blue px-5 text-sm font-black text-white transition hover:bg-[#112A43] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Confirmar importación
          </button>
        </div>
      )}
    </section>
  )
}

export function AdminDashboard({ onNavigate }: AdminDashboardProps) {
  const {
    stats,
    role,
    lowStock,
    recentOrders,
    commercialSales,
    recentActivity,
    loading,
    error,
    reloadDashboard,
  } = useDashboard()
  const [tab, setTab] = useState<DashboardTab>("operativo")
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

  if (loading || !stats) return <Skeleton />
  const sensitive = role === "admin" || role === "super_admin"
  const today = new Date()

  const filteredSales = commercialSales.filter((sale) => {
    const date = new Date(sale.date)
    return (
      (!from || date >= new Date(`${from}T00:00:00`)) &&
      (!to || date <= new Date(`${to}T23:59:59`)) &&
      (!month || date.getMonth() === Number(month)) &&
      (!year || date.getFullYear() === Number(year)) &&
      (channel === "todos" || sale.channel === channel) &&
      (!product || sale.productName === product) &&
      (!category || sale.categoryName === category)
    )
  })
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
    ganancia: filteredSales.reduce(
      (total, sale) => total + (sale.profitAmount ?? 0),
      0
    ),
  }
  const ticket =
    commercialStats.ventas > 0
      ? commercialStats.facturacionTotalFiltrada / commercialStats.ventas
      : 0
  const margin =
    commercialStats.facturacionTotalFiltrada > 0
      ? (commercialStats.ganancia / commercialStats.facturacionTotalFiltrada) * 100
      : 0
  const byChannel = ["BEYONIX Web", "MercadoLibre Marketplace"].map((label) => ({
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
  const alerts = [
    stats.productosBajoStock > 0
      ? `${stats.productosBajoStock} productos o variantes con stock bajo.`
      : null,
    stats.pagosEnRevision > 0
      ? `${stats.pagosEnRevision} pagos pendientes de revisión.`
      : null,
    stats.enviosPendientes > 0
      ? `${stats.enviosPendientes} pedidos listos para despacho.`
      : null,
    stats.productosInactivos > 0
      ? `${stats.productosInactivos} productos inactivos.`
      : null,
  ].filter(Boolean)

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
    <div className="space-y-6 p-4 sm:p-6 lg:p-8">
      <div className="rounded-3xl border border-white/8 bg-beyonix-blue p-6">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <p className="mb-2 text-11px font-bold uppercase tracking-widest text-beyonix-sky">
              Panel administrativo
            </p>
            <h1 className="text-3xl font-black text-white lg:text-4xl">
              Dashboard BEYONIX
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-white/68">
              Centro operativo por defecto y análisis comercial separado para proteger información sensible.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="inline-flex rounded-2xl border border-white/8 bg-[#141414] p-1">
              {[
                ["operativo", "Centro operativo"],
                ["comercial", "Análisis comercial"],
              ].map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  title={label}
                  aria-label={label}
                  onClick={() => setTab(key as DashboardTab)}
                  className={`inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-xl px-4 text-sm font-black transition-all ${
                    tab === key
                      ? "bg-white text-black"
                      : "text-white/65 hover:bg-white/8 hover:text-white"
                  }`}
                >
                  {key === "operativo" ? (
                    <ShoppingCart className="size-4" />
                  ) : (
                    <BarChart3 className="size-4" />
                  )}
                  {label}
                </button>
              ))}
            </div>
            <button
              type="button"
              title="Actualizar dashboard"
              aria-label="Actualizar dashboard"
              onClick={() => void reloadDashboard()}
              className="inline-flex h-12 min-w-140px cursor-pointer items-center justify-center gap-2 rounded-2xl border border-white/12 bg-white px-6 text-sm font-black text-black transition hover:-translate-y-0.5 hover:bg-white/90"
            >
              <RefreshCw className="size-4" />
              Actualizar
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-2xl border border-red-400/20 bg-red-400/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      {tab === "operativo" ? (
        <>
          <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-4">
            <StatCard
              title="Pedidos pendientes"
              value={stats.pedidosPendientes}
              helper={`${stats.esperandoComprobante} esperan comprobante · ${stats.enviosPendientes} para preparar`}
              icon={<ShoppingCart className="size-5" />}
              onClick={() => onNavigate("pedidos")}
            />
            <StatCard
              title="Pagos a revisar"
              value={stats.pagosEnRevision}
              helper="Transferencias y comprobantes"
              icon={<CreditCard className="size-5" />}
              onClick={() => onNavigate("pedidos")}
            />
            <StatCard
              title="Despachos pendientes"
              value={stats.enviosPendientes}
              helper={`${stats.pedidosSinTracking} sin tracking o etiqueta`}
              icon={<Truck className="size-5" />}
              onClick={() => onNavigate("pedidos")}
            />
            <StatCard
              title="Stock crítico"
              value={stats.productosBajoStock}
              helper="Productos y variantes bajo umbral"
              icon={<AlertTriangle className="size-5" />}
              onClick={() => onNavigate("productos")}
            />
          </div>

          <div className="grid gap-6 xl:grid-cols-2">
            <section className="rounded-3xl border border-white/8 bg-[#141414] p-5">
              <SectionHeader eyebrow="Operación" title="Últimos pedidos" />
              <div className="space-y-3">
                {recentOrders.length ? (
                  recentOrders.map((order) => (
                    <button
                      type="button"
                      title={`Abrir pedido ${order.id}`}
                      aria-label={`Abrir pedido ${order.id}`}
                      key={order.id}
                      onClick={() => onNavigate("pedidos")}
                      className="flex w-full cursor-pointer items-center justify-between gap-4 rounded-2xl border border-white/7 bg-black px-4 py-3 text-left transition hover:border-beyonix-blue-light hover:bg-beyonix-blue/20"
                    >
                      <span className="min-w-0">
                        <span className="block text-sm font-bold text-white">
                          Pedido #{order.id}
                        </span>
                        <span className="mt-1 block truncate text-xs text-white/45">
                          {order.cliente_nombre || order.cliente_email || "Cliente"}
                        </span>
                      </span>
                      <span className="text-right">
                        <span className="block text-sm font-black text-white">
                          {order.estado}
                        </span>
                        <span className="mt-1 block text-11px uppercase text-white/42">
                          {formatDate(order.created_at)}
                        </span>
                      </span>
                    </button>
                  ))
                ) : (
                  <p className="rounded-2xl border border-white/7 bg-black px-4 py-5 text-sm text-white/55">
                    No hay pedidos todavía.
                  </p>
                )}
              </div>
            </section>

            <section className="rounded-3xl border border-white/8 bg-[#141414] p-5">
              <SectionHeader eyebrow="Actividad" title="Movimientos recientes" />
              <div className="space-y-3">
                {recentActivity.length ? (
                  recentActivity.map((item) => (
                    <div
                      key={item.id}
                      className="rounded-2xl border border-white/7 bg-black px-4 py-3"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-bold text-white">
                            {item.title}
                          </p>
                          <p className="mt-1 truncate text-xs text-white/45">
                            {item.detail}
                          </p>
                        </div>
                        <span className="shrink-0 text-11px uppercase text-white/35">
                          {formatDate(item.created_at)}
                        </span>
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="rounded-2xl border border-white/7 bg-black px-4 py-5 text-sm text-white/55">
                    No hay actividad reciente.
                  </p>
                )}
              </div>
            </section>
          </div>

          <div className="grid gap-6 xl:grid-cols-3">
            <section className="rounded-3xl border border-white/8 bg-[#141414] p-5 xl:col-span-2">
              <SectionHeader
                eyebrow="Stock"
                title="Productos sin stock o bajo stock"
                action={
                  <button
                    type="button"
                    title="Ver productos"
                    aria-label="Ver productos"
                    onClick={() => onNavigate("productos")}
                    className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-2xl border border-white/10 px-4 text-sm font-black text-white/70 transition hover:border-beyonix-sky/45 hover:text-white"
                  >
                    Ver productos <ArrowRight className="size-4" />
                  </button>
                }
              />
              <div className="grid gap-3 md:grid-cols-2">
                {lowStock.length ? (
                  lowStock.slice(0, 8).map((item) => (
                    <button
                      type="button"
                      title="Abrir productos"
                      aria-label="Abrir productos"
                      key={item.id}
                      onClick={() => onNavigate("productos")}
                      className="flex cursor-pointer items-center justify-between gap-3 rounded-2xl border border-white/7 bg-black px-4 py-3 text-left transition hover:border-amber-400/35 hover:bg-amber-400/8"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-bold text-white">
                          {item.producto_nombre || item.nombre}
                        </span>
                        <span className="mt-1 block truncate text-xs text-white/45">
                          {item.tipo === "variante" ? item.nombre : "Producto"}
                        </span>
                      </span>
                      <span
                        className={`rounded-full border px-3 py-1 text-xs font-black ${
                          item.stock <= SITE_SETTINGS.stock.criticalStockThreshold
                            ? "border-red-400/25 bg-red-400/10 text-red-300"
                            : "border-amber-400/25 bg-amber-400/10 text-amber-200"
                        }`}
                      >
                        {item.stock}
                      </span>
                    </button>
                  ))
                ) : (
                  <p className="rounded-2xl border border-white/7 bg-black px-4 py-5 text-sm text-white/55 md:col-span-2">
                    No hay productos con stock bajo.
                  </p>
                )}
              </div>
            </section>

            <section className="rounded-3xl border border-white/8 bg-[#141414] p-5">
              <SectionHeader eyebrow="Alertas" title="Operativas" />
              <div className="space-y-3">
                {alerts.length ? (
                  alerts.map((alert) => (
                    <div
                      key={alert}
                      className="rounded-2xl border border-amber-400/20 bg-amber-400/8 px-4 py-3 text-sm text-amber-100"
                    >
                      {alert}
                    </div>
                  ))
                ) : (
                  <p className="rounded-2xl border border-emerald-400/20 bg-emerald-400/8 px-4 py-5 text-sm text-emerald-100">
                    No hay alertas críticas en este momento.
                  </p>
                )}
              </div>
            </section>
          </div>
        </>
      ) : (
        <>
          {!sensitive ? (
            <section className="rounded-3xl border border-white/8 bg-[#141414] p-8 text-center">
              <h2 className="text-2xl font-black text-white">Análisis comercial</h2>
              <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-white/55">
                Esta vista contiene facturación, ganancia y ticket promedio. Solo admin y super admin pueden verla.
              </p>
            </section>
          ) : (
            <>
              <section className="rounded-3xl border border-white/8 bg-[#141414] p-5">
                <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
                  <div>
                    <p className="mb-1 text-11px font-bold uppercase tracking-widest text-beyonix-cyan">
                      Análisis comercial
                    </p>
                    <h2 className="text-2xl font-black text-white">
                      Métricas y ventas
                    </h2>
                  </div>
                  <button
                    type="button"
                    title={hiddenValues ? "Mostrar valores" : "Ocultar valores"}
                    aria-label={hiddenValues ? "Mostrar valores" : "Ocultar valores"}
                    onClick={toggleHiddenValues}
                    className="inline-flex h-11 cursor-pointer items-center justify-center gap-2 rounded-2xl border border-white/10 px-5 text-sm font-black text-white/72 transition hover:border-beyonix-sky/45 hover:text-white"
                  >
                    {hiddenValues ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
                    {hiddenValues ? "Mostrar valores" : "Ocultar valores"}
                  </button>
                </div>

                <div className="mt-5 rounded-3xl border border-white/8 bg-transparent p-4">
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-admin-commercial-filters">
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

              <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-4">
                <StatCard title="Facturación diaria" value={maskAmount(formatPrice(commercialStats.facturacionDiaria), hiddenValues)} icon={<BarChart3 className="size-5" />} />
                <StatCard title="Facturación mensual" value={maskAmount(formatPrice(commercialStats.facturacionMensual), hiddenValues)} icon={<BarChart3 className="size-5" />} />
                <StatCard title="Facturación anual" value={maskAmount(formatPrice(commercialStats.facturacionAnual), hiddenValues)} icon={<BarChart3 className="size-5" />} />
                <StatCard title="Ticket promedio" value={maskAmount(formatPrice(ticket), hiddenValues)} icon={<CreditCard className="size-5" />} />
                <StatCard title="Cantidad de ventas" value={commercialStats.ventas} icon={<ShoppingCart className="size-5" />} />
                <StatCard title="Unidades vendidas" value={commercialStats.unidades} icon={<Package className="size-5" />} />
                <StatCard title="Ganancia estimada" value={maskAmount(formatPrice(commercialStats.ganancia), hiddenValues)} helper="Según neto recibido o costo disponible" icon={<BarChart3 className="size-5" />} />
                <StatCard title="Margen estimado" value={hiddenValues ? "••••" : `${margin.toFixed(1)}%`} icon={<BarChart3 className="size-5" />} />
              </div>

              <div className="grid gap-6 xl:grid-cols-3">
                <section className="rounded-3xl border border-white/8 bg-[#141414] p-5 xl:col-span-2">
                  <SectionHeader eyebrow="Facturación" title="Evolución" />
                  <MiniLineChart rows={filteredSales} hidden={hiddenValues} />
                </section>
                <section className="rounded-3xl border border-white/8 bg-[#141414] p-5">
                  <SectionHeader eyebrow="Canales" title="Ventas por canal" />
                  <BarList rows={byChannel} valueKey="amount" hidden={hiddenValues} />
                </section>
              </div>

              <div className="grid gap-6 xl:grid-cols-2">
                <section className="rounded-3xl border border-white/8 bg-[#141414] p-5">
                  <SectionHeader eyebrow="Productos" title="Más vendidos" />
                  <BarList rows={byProduct} valueKey="value" />
                </section>
                <MercadoLibreImporter onImported={() => void reloadDashboard()} />
              </div>

              <section className="rounded-3xl border border-white/8 bg-[#141414] p-5">
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
                          ["costAmount", "Costo estimado"],
                          ["profitAmount", "Ganancia estimada"],
                          ["marginPercent", "Margen %"],
                          ["ticket", "Ticket promedio"],
                        ].map(([key, label]) => (
                          <th key={key} className="px-4 py-3">
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
                            <td className="px-4 py-3 text-white/62">{sale.paymentMethod}</td>
                            <td className="px-4 py-3 text-white/62">{sale.quantity}</td>
                            <td className="px-4 py-3 text-white/62">{maskAmount(formatPrice(sale.grossAmount), hiddenValues)}</td>
                            <td className="px-4 py-3 text-white/62">{sale.costAmount == null ? "-" : maskAmount(formatPrice(sale.costAmount), hiddenValues)}</td>
                            <td className="px-4 py-3 text-white/62">{sale.profitAmount == null ? "-" : maskAmount(formatPrice(sale.profitAmount), hiddenValues)}</td>
                            <td className="px-4 py-3 text-white/62">{sale.marginPercent == null || hiddenValues ? (hiddenValues ? "••••" : "-") : `${sale.marginPercent.toFixed(1)}%`}</td>
                            <td className="px-4 py-3 text-white/62">{maskAmount(formatPrice(rowTicket), hiddenValues)}</td>
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
