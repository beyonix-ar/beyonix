"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { ClipboardPaste, Eye, FileSpreadsheet, Pencil, Plus, RefreshCw, ShoppingBag, X } from "lucide-react"

import {
  EXTERNAL_SALE_CHANNEL_LABELS,
  EXTERNAL_SALE_CHANNELS,
  EXTERNAL_SALE_STATUS_LABELS,
  EXTERNAL_SALE_STOCK_EFFECT_LABELS,
  externalSaleCode,
} from "@/lib/business/external-sales"
import {
  getExternalSales,
  type ExternalSaleFilters,
  type ExternalSaleListItem,
} from "@/lib/supabase/queries/external-sales"
import { cn } from "@/lib/utils"
import { formatPrice } from "../productos/helpers"
import { AdminDatePicker } from "../../components/admin-date-picker"
import { AdminResponsiveTable } from "../../components/admin-responsive-table"
import {
  AdminBadge,
  AdminButton,
  AdminEmptyState,
  AdminSecondaryButton,
  AdminSelect,
  AdminTextInput,
} from "../../components/admin-controls"
import { ExternalSaleDetailModal } from "./external-sale-detail-modal"
import { ExternalSaleFormModal } from "./external-sale-form-modal"
import { ExternalSalesImportHistory } from "./external-sales-import-history"
import { ExternalSalesImportModal } from "./external-sales-import-modal"

type View = "sales" | "imports"

const formatDate = (value: string) => value.slice(0, 10).split("-").reverse().join("/")

export function AdminExternalSales() {
  const [view, setView] = useState<View>("sales")
  const [filters, setFilters] = useState<ExternalSaleFilters>({ status: "" })
  const [sales, setSales] = useState<ExternalSaleListItem[]>([])
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [success, setSuccess] = useState("")
  const [formSale, setFormSale] = useState<ExternalSaleListItem | null | undefined>(undefined)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [importSource, setImportSource] = useState<"paste" | "file" | null>(null)
  const [historyToken, setHistoryToken] = useState(0)
  const [skuInput, setSkuInput] = useState("")

  useEffect(() => {
    const timer = setTimeout(() => setFilters((current) => (
      (current.sku ?? "") === skuInput.trim() ? current : { ...current, sku: skuInput.trim() }
    )), 350)
    return () => clearTimeout(timer)
  }, [skuInput])

  const load = useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      const result = await getExternalSales(filters)
      setSales(result.sales)
      setTruncated(result.truncated)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "No se pudieron cargar las ventas externas.")
    } finally {
      setLoading(false)
    }
  }, [filters])

  useEffect(() => {
    void load()
  }, [load])

  const totals = useMemo(() => sales.filter((sale) => sale.status !== "reversed").reduce(
    (acc, sale) => ({
      count: acc.count + 1,
      units: acc.units + Number(sale.quantity),
      gross: acc.gross + Number(sale.gross_amount),
      profit: acc.profit + Number(sale.profit_amount ?? 0),
      unknownProfit: acc.unknownProfit + (sale.profit_amount == null ? 1 : 0),
    }),
    { count: 0, units: 0, gross: 0, profit: 0, unknownProfit: 0 },
  ), [sales])

  const setFilter = <K extends keyof ExternalSaleFilters>(key: K, value: ExternalSaleFilters[K]) =>
    setFilters((current) => ({ ...current, [key]: value }))

  const changed = (message: string) => {
    setSuccess(message)
    setFormSale(undefined)
    setDetailId(null)
    setImportSource(null)
    setHistoryToken((token) => token + 1)
    void load()
  }

  if (!loading && error && sales.length === 0) {
    return (
      <div className="rounded-2xl border border-red-400/25 bg-red-400/10 p-6 text-center text-red-100">
        <p className="text-sm font-bold">{error}</p>
        <AdminSecondaryButton className="mt-4" onClick={() => void load()}>
          <RefreshCw className="size-3.5" /> Reintentar
        </AdminSecondaryButton>
      </div>
    )
  }

  return (
    <div className="admin-dashboard-panel admin-external-sales space-y-3">
      <section className="rounded-2xl border border-beyonix-blue-light/18 bg-[linear-gradient(145deg,rgba(7,16,24,0.9),rgba(3,7,13,0.98))] p-3.5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-11px font-black uppercase tracking-widest text-beyonix-cyan">Registro comercial</p>
            <h2 className="mt-1 text-xl font-black text-white">Ventas externas</h2>
            <p className="mt-1 max-w-2xl text-sm leading-5 text-white/55">
              Ventas por WhatsApp, Instagram o en persona. No son pedidos web ni ventas de Mercado Libre.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <AdminButton variant="primary" size="sm" icon={<Plus className="size-3.5" />} onClick={() => setFormSale(null)}>Nueva venta</AdminButton>
            <AdminButton size="sm" icon={<ClipboardPaste className="size-3.5" />} onClick={() => setImportSource("paste")}>Pegar ventas</AdminButton>
            <AdminButton size="sm" icon={<FileSpreadsheet className="size-3.5" />} onClick={() => setImportSource("file")}>Importar archivo</AdminButton>
          </div>
        </div>

        <div className="mt-2.5 grid grid-cols-2 gap-2 xl:grid-cols-4">
          {[
            ["Ventas", String(totals.count), "text-white"],
            ["Unidades", String(totals.units), "text-white"],
            ["Facturación", formatPrice(totals.gross), "text-white"],
            ["Ganancia", formatPrice(totals.profit), totals.profit >= 0 ? "text-emerald-300" : "text-red-300"],
          ].map(([label, value, tone]) => (
            <div key={label} className="rounded-xl border border-white/8 bg-black/25 p-2.5 text-center">
              <p className="text-10px font-black uppercase tracking-widest text-white/40">{label}</p>
              <p className={cn("mt-1 text-xl font-black", tone)}>{value}</p>
            </div>
          ))}
        </div>
        {totals.unknownProfit > 0 && (
          <p className="mt-2 text-xs text-white/45">{totals.unknownProfit} ventas sin costo conocido ni ganancia declarada no suman a la ganancia.</p>
        )}
      </section>

      <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Vista de ventas externas">
        {([["sales", "Ventas"], ["imports", "Historial de importaciones"]] as const).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={view === value}
            onClick={() => setView(value)}
            className={cn(
              "h-9 cursor-pointer rounded-xl border px-4 text-xs font-black transition",
              view === value ? "border-beyonix-sky/45 bg-beyonix-blue/30 text-white" : "border-white/10 text-white/55 hover:text-white",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {success && (
        <p className="rounded-xl border border-emerald-400/20 bg-emerald-400/9 px-4 py-3 text-sm text-emerald-200">{success}</p>
      )}
      {error && sales.length > 0 && (
        <p role="alert" className="rounded-xl border border-red-400/20 bg-red-400/9 px-4 py-3 text-sm text-red-200">{error}</p>
      )}

      {view === "imports" ? (
        <ExternalSalesImportHistory
          refreshToken={historyToken}
          onShowSales={(batchId) => { setSkuInput(""); setFilters({ status: "", batch: batchId }); setView("sales") }}
          onChanged={changed}
        />
      ) : (
        <section className="rounded-2xl border border-beyonix-blue-light/18 bg-[#071018] p-3.5 sm:p-4">
          <div className="mb-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
            <AdminDatePicker title="Desde" ariaLabel="Ventas desde" placeholder="Desde" value={filters.from ?? ""} compact onChange={(value) => setFilter("from", value)} />
            <AdminDatePicker title="Hasta" ariaLabel="Ventas hasta" placeholder="Hasta" value={filters.to ?? ""} compact onChange={(value) => setFilter("to", value)} />
            <AdminSelect title="Canal" compact value={filters.channel ?? ""} onChange={(value) => setFilter("channel", value as ExternalSaleFilters["channel"])}>
              <option value="">Todos los canales</option>
              {EXTERNAL_SALE_CHANNELS.map((channel) => <option key={channel} value={channel}>{EXTERNAL_SALE_CHANNEL_LABELS[channel]}</option>)}
              <option value="none">Sin canal</option>
            </AdminSelect>
            <AdminSelect title="Estado" compact value={filters.status ?? ""} onChange={(value) => setFilter("status", value as ExternalSaleFilters["status"])}>
              <option value="">Todos los estados</option>
              <option value="active">Vigentes</option>
              <option value="completed">Confirmadas</option>
              <option value="delivered">Entregadas</option>
              <option value="reversed">Anuladas</option>
            </AdminSelect>
            <AdminSelect title="Tipo de stock" compact value={filters.stockEffect ?? ""} onChange={(value) => setFilter("stockEffect", value as ExternalSaleFilters["stockEffect"])}>
              <option value="">Históricas y nuevas</option>
              <option value="none">Históricas</option>
              <option value="consume">Nuevas</option>
            </AdminSelect>
            <AdminTextInput title="SKU" placeholder="Buscar SKU" value={skuInput} maxLength={120} onChange={setSkuInput} />
          </div>
          {filters.batch && (
            <div className="mb-3 flex items-center gap-2 text-xs text-white/60">
              <AdminBadge tone="info">Filtrando una tanda importada</AdminBadge>
              <button type="button" className="inline-flex cursor-pointer items-center gap-1 text-white/55 hover:text-white" onClick={() => setFilter("batch", undefined)}>
                <X className="size-3" /> Quitar filtro
              </button>
            </div>
          )}

          <div className="sales-ledger-scrollbar overflow-x-auto rounded-2xl border border-beyonix-blue-light/16 bg-black/20">
            <AdminResponsiveTable labels={["Fecha", "Cliente", "Canal", "SKU", "Producto", "Cant.", "Precio final", "Ganancia", "Estado", "Acciones"]}>
              <table className="w-full min-w-[1080px] text-center text-xs">
                <thead>
                  <tr className="text-10px font-black uppercase tracking-widest text-white/38">
                    {["Fecha", "Cliente", "Canal", "SKU", "Producto", "Cant.", "Precio final", "Ganancia", "Estado", "Acciones"].map((label) => (
                      <th key={label} className="px-2 py-3">{label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sales.map((sale) => {
                    const reversed = sale.status === "reversed"
                    return (
                      <tr
                        key={sale.id}
                        onClick={() => setDetailId(sale.id)}
                        className={cn("cursor-pointer border-t border-white/6 text-white/65 transition hover:bg-white/3", reversed && "opacity-55")}
                      >
                        <td className="whitespace-nowrap px-2 py-2.5">
                          {formatDate(sale.sale_date)}
                          <span className="block text-10px text-white/35">{externalSaleCode(sale.sale_number)}</span>
                        </td>
                        <td className="max-w-40 truncate px-2 py-2.5" title={sale.customer_name ?? ""}>{sale.customer_name || "—"}</td>
                        <td className="px-2 py-2.5">{sale.channel ? EXTERNAL_SALE_CHANNEL_LABELS[sale.channel] : "—"}</td>
                        <td className="px-2 py-2.5 font-mono">{sale.sku || "—"}</td>
                        <td className="max-w-56 px-2 py-2.5 font-bold text-white">
                          <span className="block truncate" title={sale.product_name}>{sale.product_name}</span>
                          <span className="text-10px font-normal text-white/40">{EXTERNAL_SALE_STOCK_EFFECT_LABELS[sale.stock_effect]}</span>
                        </td>
                        <td className="px-2 py-2.5 tabular-nums">{sale.quantity}</td>
                        <td className="px-2 py-2.5 tabular-nums text-white">{formatPrice(Number(sale.gross_amount))}</td>
                        <td className={cn("px-2 py-2.5 tabular-nums", sale.profit_amount == null ? "text-white/35" : sale.profit_amount >= 0 ? "text-emerald-300" : "text-red-300")}>
                          {sale.profit_amount == null ? "—" : formatPrice(sale.profit_amount)}
                        </td>
                        <td className="px-2 py-2.5">
                          <AdminBadge tone={reversed ? "danger" : sale.status === "delivered" ? "success" : "info"}>{EXTERNAL_SALE_STATUS_LABELS[sale.status]}</AdminBadge>
                        </td>
                        <td className="px-2 py-2" onClick={(event) => event.stopPropagation()}>
                          <div className="flex justify-center gap-1.5">
                            <button type="button" aria-label={`Ver venta ${externalSaleCode(sale.sale_number)}`} title="Ver" onClick={() => setDetailId(sale.id)} className="flex size-8 cursor-pointer items-center justify-center rounded-lg border border-white/12 text-white/70 hover:text-white">
                              <Eye className="size-3.5" />
                            </button>
                            <button type="button" aria-label={`Editar venta ${externalSaleCode(sale.sale_number)}`} title="Editar" disabled={reversed} onClick={() => setFormSale(sale)} className="flex size-8 cursor-pointer items-center justify-center rounded-lg border border-beyonix-sky/22 bg-beyonix-blue/24 text-beyonix-sky disabled:cursor-not-allowed disabled:opacity-40">
                              <Pencil className="size-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </AdminResponsiveTable>
            {loading && (
              <div className="flex items-center justify-center gap-2 border-t border-white/7 px-5 py-10 text-sm text-white/45">
                <RefreshCw className="size-4 animate-spin" /> Cargando ventas…
              </div>
            )}
          </div>
          {!loading && sales.length === 0 && (
            <AdminEmptyState
              className="mt-3"
              icon={<ShoppingBag className="size-6" />}
              title="No hay ventas externas para estos filtros."
              description="Registrá una venta con “Nueva venta” o cargá tu Excel con “Pegar ventas”."
            />
          )}
          {truncated && <p className="mt-2 text-xs text-amber-200">Se muestran las 2000 ventas más recientes. Usá los filtros para acotar.</p>}
        </section>
      )}

      {formSale !== undefined && (
        <ExternalSaleFormModal
          key={formSale?.id ?? "new"}
          open
          sale={formSale}
          onClose={() => setFormSale(undefined)}
          onSaved={(_, message) => changed(message)}
        />
      )}
      {detailId && (
        <ExternalSaleDetailModal
          key={detailId}
          saleId={detailId}
          onClose={() => setDetailId(null)}
          onEdit={(sale) => { setDetailId(null); setFormSale(sale) }}
          onChanged={changed}
        />
      )}
      {importSource && (
        <ExternalSalesImportModal
          key={importSource}
          source={importSource}
          onClose={() => setImportSource(null)}
          onImported={(message) => { setSkuInput(""); setFilters({ status: "" }); changed(message) }}
        />
      )}
    </div>
  )
}
