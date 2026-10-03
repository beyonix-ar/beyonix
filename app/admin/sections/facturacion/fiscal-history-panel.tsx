"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { Download, ExternalLink, FileText, LoaderCircle } from "lucide-react"

import { supabase } from "@/lib/supabase/client"
import {
  argentinaToday,
  FISCAL_EXPORT_LIMIT,
  type FiscalDocument,
  type FiscalKind,
  type FiscalPeriod,
} from "@/lib/arca/fiscal-history"
import { formatPrice } from "../productos/helpers"
import {
  AdminBadge,
  AdminEmptyState,
  AdminPrimaryButton,
  AdminSearchInput,
  AdminSecondaryButton,
  AdminSkeleton,
  adminSurfaceLevel,
} from "../../components/admin-controls"

const MONTHS = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"]

type Filters = {
  search: string
  number: string
  order: string
  client: string
  document: string
  date: string
  cae: string
  amount: string
  status: string
}

const EMPTY_FILTERS: Filters = { search: "", number: "", order: "", client: "", document: "", date: "", cae: "", amount: "", status: "" }

function documentDate(day: string) {
  return new Intl.DateTimeFormat("es-AR", { dateStyle: "long", timeZone: "UTC" }).format(new Date(`${day}T12:00:00Z`))
}

function number(point: number, voucher: number) {
  return `${String(point).padStart(4, "0")}-${String(voucher).padStart(8, "0")}`
}

function filenameFromResponse(response: Response, fallback: string) {
  return response.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] ?? fallback
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

async function adminRequest(path: string, init: RequestInit = {}) {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token) throw new Error("La sesión administrativa venció.")
  const headers = new Headers(init.headers)
  headers.set("Authorization", `Bearer ${session.access_token}`)
  return fetch(path, { ...init, headers })
}

function groupedByDay(items: FiscalDocument[]) {
  const groups = new Map<string, FiscalDocument[]>()
  for (const item of items) groups.set(item.day, [...(groups.get(item.day) ?? []), item])
  return [...groups.entries()].sort(([a], [b]) => b.localeCompare(a))
}

export function FiscalHistoryPanel({ kind }: { kind: FiscalKind }) {
  const router = useRouter()
  const today = useMemo(() => argentinaToday(), [])
  const [period, setPeriod] = useState<FiscalPeriod>("today")
  const [year, setYear] = useState(Number(today.slice(0, 4)))
  const [month, setMonth] = useState(Number(today.slice(5, 7)))
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  const [appliedFilters, setAppliedFilters] = useState<Filters>(EMPTY_FILTERS)
  const [page, setPage] = useState(1)
  const [items, setItems] = useState<FiscalDocument[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())

  const title = kind === "invoice" ? "Facturas C" : "Notas de Crédito C"
  const selectedLabel = kind === "invoice" ? "facturas" : "notas de crédito"
  const selectedCountLabel = kind === "invoice"
    ? selected.size === 1 ? "factura seleccionada" : "facturas seleccionadas"
    : selected.size === 1 ? "nota de crédito seleccionada" : "notas de crédito seleccionadas"

  useEffect(() => {
    const timer = window.setTimeout(() => { setAppliedFilters(filters); setPage(1) }, 300)
    return () => window.clearTimeout(timer)
  }, [filters])

  useEffect(() => { setSelected(new Set()) }, [period, year, month, appliedFilters])

  const query = useMemo(() => {
    const params = new URLSearchParams({ kind, period, year: String(year), month: String(month), page: String(page) })
    for (const [key, value] of Object.entries(appliedFilters)) if (value.trim()) params.set(key, value.trim())
    return params
  }, [kind, period, year, month, page, appliedFilters])

  const load = useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      const response = await adminRequest(`/api/admin/facturacion/history?${query}`)
      const result = await response.json() as { items?: FiscalDocument[]; total?: number; error?: string }
      if (!response.ok || !result.items) throw new Error(result.error || "No se pudo cargar el historial fiscal.")
      setItems(result.items)
      setTotal(result.total ?? 0)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo cargar el historial fiscal.")
      setItems([])
      setTotal(0)
    } finally {
      setLoading(false)
    }
  }, [query])

  useEffect(() => { void load() }, [load])

  const changeFilter = (name: keyof Filters, value: string) => {
    setFilters((current) => ({ ...current, [name]: value }))
    if (value.trim()) setPeriod("all")
  }
  const groups = groupedByDay(items)
  const visibleIds = items.map((item) => item.id)
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id))

  const toggleIds = (ids: string[]) => {
    setSelected((current) => {
      const next = new Set(current)
      if (ids.every((id) => next.has(id))) ids.forEach((id) => next.delete(id))
      else ids.forEach((id) => next.add(id))
      return next
    })
  }

  const selectDay = async (day: string) => {
    setBusy(true)
    setError("")
    try {
      const params = new URLSearchParams(query)
      params.set("ids", "1")
      params.set("day", day)
      const response = await adminRequest(`/api/admin/facturacion/history?${params}`)
      const result = await response.json() as { ids?: string[]; error?: string }
      if (!response.ok || !result.ids) throw new Error(result.error || "No se pudo seleccionar el día.")
      toggleIds(result.ids)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo seleccionar el día.")
    } finally {
      setBusy(false)
    }
  }

  const exportDocuments = async (scope: "selected" | "month") => {
    if (scope === "selected" && !selected.size) return
    setBusy(true)
    setError("")
    try {
      const response = await adminRequest("/api/admin/facturacion/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(scope === "selected"
          ? { kind, scope, ids: [...selected] }
          : { kind, scope, year, month }),
      })
      if (!response.ok) {
        const result = await response.json() as { error?: string }
        throw new Error(result.error || "No se pudo preparar la descarga.")
      }
      const extension = response.headers.get("content-type")?.includes("application/pdf") ? "pdf" : "zip"
      downloadBlob(await response.blob(), filenameFromResponse(response, `${selectedLabel}.${extension}`))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo descargar el comprobante.")
    } finally {
      setBusy(false)
    }
  }

  const singlePdf = async (item: FiscalDocument, preview: boolean) => {
    const tab = preview ? window.open("about:blank", "_blank") : null
    setBusy(true)
    setError("")
    try {
      const params = new URLSearchParams()
      if (kind === "credit_note") { params.set("type", "credit_note"); params.set("note", item.id) }
      const response = await adminRequest(`/api/admin/orders/${item.order_id}/invoice/pdf?${params}`)
      if (!response.ok) throw new Error("No se pudo obtener el comprobante.")
      const blob = await response.blob()
      if (preview && tab) {
        const url = URL.createObjectURL(blob)
        tab.location.href = url
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
      } else {
        downloadBlob(blob, filenameFromResponse(response, `${selectedLabel}.pdf`))
      }
    } catch (cause) {
      tab?.close()
      setError(cause instanceof Error ? cause.message : "No se pudo obtener el comprobante.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <section data-fiscal-history={kind} className={`${adminSurfaceLevel.section} min-w-0 rounded-2xl border border-white/10 bg-white/3 p-3 sm:p-5`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h2 className="text-sm font-black text-white">{title}</h2><p className="mt-1 text-xs text-white/55">Historial fiscal persistido · {total} comprobantes en este resultado</p></div>
        <div className="flex flex-wrap gap-2" aria-label="Período fiscal">
          {(["today", "month", "all"] as const).map((value) => (
            <AdminSecondaryButton key={value} size="sm" aria-pressed={period === value} onClick={() => {
              if (value === "month") { setYear(Number(today.slice(0, 4))); setMonth(Number(today.slice(5, 7))) }
              setPeriod(value); setPage(1)
            }}>{value === "today" ? "Hoy" : value === "month" ? "Este mes" : "Historial"}</AdminSecondaryButton>
          ))}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <div className="min-w-48 flex-1 sm:max-w-sm"><AdminSearchInput title="Búsqueda general" ariaLabel="Buscar comprobantes" value={filters.search} placeholder="Número, pedido, cliente, CAE..." onChange={(value) => changeFilter("search", value)} /></div>
        <label className="text-xs font-semibold text-white/70">Mes
          <select aria-label="Mes fiscal" value={month} onChange={(event) => { setMonth(Number(event.target.value)); setPeriod("month"); setPage(1) }} className="mt-1 block h-10 rounded-lg border border-white/15 bg-[#111c2b] px-3 text-sm text-white">
            {MONTHS.map((name, index) => <option key={name} value={index + 1}>{name}</option>)}
          </select>
        </label>
        <div className="flex items-center gap-1 text-xs font-semibold text-white/70">
          <AdminSecondaryButton size="sm" aria-label="Año anterior" onClick={() => { setYear((value) => Math.max(2000, value - 1)); setPeriod("month"); setPage(1) }}>‹</AdminSecondaryButton>
          <span aria-label="Año fiscal" className="min-w-12 text-center">{year}</span>
          <AdminSecondaryButton size="sm" aria-label="Año siguiente" onClick={() => { setYear((value) => Math.min(2100, value + 1)); setPeriod("month"); setPage(1) }}>›</AdminSecondaryButton>
        </div>
        <AdminSecondaryButton size="sm" disabled={busy} onClick={() => void exportDocuments("month")}><Download className="size-4" />Descargar mes completo</AdminSecondaryButton>
      </div>

      <details className="mt-3 rounded-xl border border-white/10 bg-white/2 px-3 py-2 text-xs text-white/70">
        <summary className="cursor-pointer font-bold">Filtros</summary>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {([
            ["number", "Número de comprobante", "text"], ["order", "Pedido", "text"],
            ["client", "Cliente", "text"], ["document", "Documento", "text"],
            ["date", "Fecha", "date"], ["cae", "CAE", "text"],
            ["amount", "Importe", "number"],
          ] as const).map(([name, label, type]) => <label key={name} className="font-semibold">{label}<input aria-label={label} type={type} min={type === "number" ? "0" : undefined} step={type === "number" ? "0.01" : undefined} value={filters[name]} onChange={(event) => changeFilter(name, event.target.value)} className="mt-1 block h-9 w-full rounded-lg border border-white/15 bg-[#111c2b] px-2 text-sm text-white" /></label>)}
          <label className="font-semibold">Estado<select aria-label="Estado" value={filters.status} onChange={(event) => changeFilter("status", event.target.value)} className="mt-1 block h-9 w-full rounded-lg border border-white/15 bg-[#111c2b] px-2 text-sm text-white"><option value="">Todos</option><option value="authorized">Autorizada</option></select></label>
        </div>
      </details>

      {error && <p role="alert" className="mt-3 text-sm text-red-200">{error}</p>}
      <div className="mt-4 flex flex-wrap items-center gap-2 border-b border-white/10 pb-3 text-xs text-white/70">
        <label className="flex cursor-pointer items-center gap-2"><input type="checkbox" aria-label="Seleccionar todas las visibles" checked={allVisibleSelected} onChange={() => toggleIds(visibleIds)} disabled={!visibleIds.length} />Seleccionar todas las visibles</label>
        {selected.size > 0 && <><span className="ml-auto font-bold">{selected.size} {selectedCountLabel}</span><AdminPrimaryButton size="sm" disabled={busy || selected.size > FISCAL_EXPORT_LIMIT} onClick={() => void exportDocuments("selected")}><Download className="size-4" />Descargar seleccionadas</AdminPrimaryButton><AdminSecondaryButton size="sm" onClick={() => setSelected(new Set())}>Limpiar selección</AdminSecondaryButton></>}
      </div>

      {loading ? <AdminSkeleton rows={5} className="p-3" /> : items.length === 0 ? <AdminEmptyState icon={<FileText className="size-5" />} title="No hay comprobantes para este período y filtros." /> : groups.map(([day, rows]) => (
        <div key={day} data-fiscal-day={day} className="mt-4">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/15 px-1 pb-2">
            <h3 className="text-sm font-black capitalize text-white">{documentDate(day)}</h3>
            <AdminSecondaryButton size="sm" disabled={busy} onClick={() => void selectDay(day)}>Seleccionar todas las del día</AdminSecondaryButton>
          </div>
          <div className="divide-y divide-white/8">
            {rows.map((item) => <div key={item.id} data-fiscal-row={item.id} className="grid min-w-0 grid-cols-2 gap-x-3 gap-y-2 px-2 py-3 text-xs text-white/75 sm:grid-cols-[auto_repeat(3,minmax(0,1fr))] xl:grid-cols-[auto_1fr_1fr_1.3fr_.8fr_.8fr_1.2fr_1fr_1.8fr] xl:items-center">
              <input type="checkbox" aria-label={`Seleccionar ${kind === "invoice" ? "factura" : "nota"} ${item.display_number}`} checked={selected.has(item.id)} onChange={() => toggleIds([item.id])} className="col-span-2 mt-1 sm:col-span-1" />
              <div className="min-w-0"><span className="block text-10px uppercase text-white/45">{kind === "invoice" ? "Factura" : "Nota de crédito"}</span><strong className="text-white">{item.display_number}</strong>{item.environment === "homologation" && <span className="ml-1 text-amber-200">· prueba</span>}</div>
              <div><span className="block text-10px uppercase text-white/45">Pedido</span>BX-{1000 + item.order_id}{kind === "credit_note" && item.original_point && item.original_number && <span className="block text-white/55">Factura {number(item.original_point, item.original_number)}</span>}</div>
              <div className="min-w-0"><span className="block text-10px uppercase text-white/45">Cliente</span><span className="block truncate font-semibold text-white">{item.client || "Consumidor final"}</span><span className="block truncate text-white/55">{item.document || "Sin documento"}</span></div>
              <div><span className="block text-10px uppercase text-white/45">Fecha</span>{documentDate(item.day)}</div>
              <div><span className="block text-10px uppercase text-white/45">{kind === "invoice" ? "Total" : "Importe"}</span>{formatPrice(Number(item.amount))}</div>
              <div className="min-w-0"><span className="block text-10px uppercase text-white/45">CAE</span><span className="block truncate" title={item.cae}>{item.cae}</span>{kind === "credit_note" && item.reason && <span className="block truncate text-white/55" title={item.reason}>{item.reason}</span>}</div>
              <div><span className="block text-10px uppercase text-white/45">Estado</span><AdminBadge tone="success">Autorizada</AdminBadge></div>
              <div className="col-span-2 flex flex-wrap gap-1 sm:col-span-3 xl:col-span-1 xl:justify-end">
                <AdminSecondaryButton size="sm" onClick={() => router.push(`/admin/pedidos/${item.order_id}?tab=pago`)}><ExternalLink className="size-3.5" />Ver pedido</AdminSecondaryButton>
                <AdminSecondaryButton size="sm" disabled={busy} onClick={() => void singlePdf(item, true)}>Ver comprobante</AdminSecondaryButton>
                <AdminSecondaryButton size="sm" disabled={busy} onClick={() => void singlePdf(item, false)}>Descargar PDF</AdminSecondaryButton>
              </div>
            </div>)}
          </div>
        </div>
      ))}

      <div className="mt-4 flex items-center justify-between border-t border-white/10 pt-3 text-xs text-white/60">
        <span>{loading ? <LoaderCircle className="size-4 animate-spin" /> : `${total} resultados · página ${page} de ${Math.max(1, Math.ceil(total / 30))}`}</span>
        <div className="flex gap-2"><AdminSecondaryButton size="sm" disabled={page <= 1 || loading} onClick={() => setPage((value) => value - 1)}>Anterior</AdminSecondaryButton><AdminSecondaryButton size="sm" disabled={page * 30 >= total || loading} onClick={() => setPage((value) => value + 1)}>Siguiente</AdminSecondaryButton></div>
      </div>
      <p className="mt-2 text-11px text-white/45">Máximo {FISCAL_EXPORT_LIMIT} comprobantes por descarga.</p>
    </section>
  )
}
