"use client"

import { useState } from "react"
import { ChevronDown, FileUp, PackageSearch } from "lucide-react"
import { useSearchParams } from "next/navigation"

import { AdminHelpTip } from "@/app/admin/components/admin-help-tip"
import { AdminButton, AdminEmptyState, AdminPageHeader, AdminSection, AdminTrackingValue } from "@/app/admin/components/admin-controls"
import type { LogisticsOrderRow } from "@/lib/admin/logistics"
import { BILLED_HELP } from "@/lib/admin/andreani-billing"
import {
  BillingImportModal,
  ReconciliationBadge,
  ReconcileOrderModal,
  signedOrDash,
  UnmatchedBillingList,
} from "./billing-reconciliation"
import {
  currentMonthRange,
  formatMoney,
  formatSignedMoney,
  formatSignedPercent,
  LOGISTICS_HELP,
  LogisticsRangeFilter,
  LogisticsSummaryGrid,
  useLogistics,
} from "./logistics-summary"

const DATE = /^\d{4}-\d{2}-\d{2}$/
const money = (value: number | null) => value === null ? "—" : formatMoney(value)
const formatDate = (value: string) =>
  new Date(value).toLocaleDateString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit", year: "numeric" })

const COLUMNS: Array<{ label: string; help?: string }> = [
  { label: "Pedido" },
  { label: "Fecha" },
  { label: "Tracking" },
  { label: "Estado" },
  { label: "Paquetes de envío" },
  { label: "Cobrado cliente", help: LOGISTICS_HELP.charged },
  { label: "Facturado Andreani", help: BILLED_HELP },
  { label: "Diferencia", help: LOGISTICS_HELP.difference },
  { label: "Estado conciliación", help: LOGISTICS_HELP.reconciliation },
  { label: "Detalle y acción" },
]

const DETAILS: Array<{ label: string; help?: string; value: (row: LogisticsOrderRow) => string }> = [
  { label: "Tarifa checkout", help: LOGISTICS_HELP.providerQuoted, value: (row) => money(row.checkoutQuote) },
  { label: "Recargo %", help: LOGISTICS_HELP.markupPercent, value: (row) => row.markupPercent === null ? "—" : `${new Intl.NumberFormat("es-AR", { maximumFractionDigits: 2 }).format(row.markupPercent)}%` },
  { label: "Extra cobrado", help: LOGISTICS_HELP.markup, value: (row) => money(row.markupAmount) },
  { label: "Beneficio", help: LOGISTICS_HELP.benefit, value: (row) => money(row.benefit) },
  { label: "Cotizado con paquetes de envío medidos", help: LOGISTICS_HELP.parcelQuoted, value: (row) => money(row.parcelQuote) },
  { label: "Dif. vs checkout", help: LOGISTICS_HELP.billedVsCheckout, value: (row) => signedOrDash(row.billedVsCheckout) },
  { label: "Dif. vs armado", help: LOGISTICS_HELP.billedVsParcel, value: (row) => signedOrDash(row.billedVsParcel) },
]

export function LogisticsOrderTableRow({ row, onReconcile }: { row: LogisticsOrderRow; onReconcile: (row: LogisticsOrderRow) => void }) {
  const [expanded, setExpanded] = useState(false)
  const detailId = `logistics-order-detail-${row.id}`
  return (
    <>
      <tr className="border-t border-white/8 text-sm text-white/85 hover:bg-white/[0.03]">
        <td className="whitespace-nowrap px-3 py-3 font-black text-white">{row.code}</td>
        <td className="whitespace-nowrap px-3 py-3 text-white/65">{formatDate(row.createdAt)}</td>
        <td className="whitespace-nowrap px-3 py-3 font-mono text-xs">{row.tracking ? <AdminTrackingValue value={row.tracking} label={`seguimiento del pedido ${row.code}`} /> : "—"}</td>
        <td className="whitespace-nowrap px-3 py-3">{row.status}</td>
        <td className="px-3 py-3 text-right tabular-nums">{row.parcels ?? "—"}</td>
        <td className="whitespace-nowrap px-3 py-3 text-right tabular-nums">{money(row.chargedToCustomer)}</td>
        <td className="whitespace-nowrap px-3 py-3 text-right tabular-nums">{row.billedOutbound === null && row.billedTotal === null ? <span className="text-white/55">Pendiente</span> : <>{money(row.billedOutbound)}{row.billedTotal !== null && row.billedTotal !== row.billedOutbound ? <span className="block text-xs text-white/60">Total {formatMoney(row.billedTotal)}</span> : null}</>}</td>
        <td className="whitespace-nowrap px-3 py-3 text-right tabular-nums">{row.difference === null ? "—" : <>{formatSignedMoney(row.difference)}{row.differencePercent === null ? null : <span className="block text-xs text-white/60">{formatSignedPercent(row.differencePercent)}</span>}</>}</td>
        <td className="whitespace-nowrap px-3 py-3"><ReconciliationBadge status={row.reconciliation} /></td>
        <td className="whitespace-nowrap px-3 py-3"><button type="button" aria-expanded={expanded} aria-controls={expanded ? detailId : undefined} onClick={() => setExpanded((value) => !value)} className="inline-flex items-center gap-1 text-xs font-bold text-beyonix-cyan hover:text-white">{expanded ? "Ocultar detalle" : "Ver detalle"}<ChevronDown className={`size-3.5 transition-transform ${expanded ? "rotate-180" : ""}`} /></button></td>
      </tr>
      {expanded ? <tr className="border-t border-white/8 bg-[rgba(8,20,35,0.84)]"><td colSpan={COLUMNS.length} className="p-4 sm:p-5"><div id={detailId} className="space-y-4">
        <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">{DETAILS.map((item) => <div key={item.label} className="min-w-0"><p className="flex items-center gap-1 text-10px font-black uppercase tracking-wider text-white/50">{item.label}{item.help ? <AdminHelpTip label={item.label} text={item.help} /> : null}</p><p className="mt-1 text-sm font-bold tabular-nums text-white">{item.value(row)}</p></div>)}
          <div className="min-w-0"><p className="text-10px font-black uppercase tracking-wider text-white/50">Referencia</p><p className="mt-1 break-all font-mono text-xs text-white/85">{row.references ?? "—"}</p></div>
        </div>
        <AdminButton size="sm" onClick={() => onReconcile(row)}>Conciliar pedido</AdminButton>
      </div></td></tr> : null}
    </>
  )
}

export function AdminLogistica() {
  const params = useSearchParams()
  const [range, setRange] = useState(() => {
    const fallback = currentMonthRange()
    const from = params.get("from") ?? ""
    const to = params.get("to") ?? ""
    return { from: DATE.test(from) ? from : fallback.from, to: DATE.test(to) ? to : fallback.to }
  })
  const [page, setPage] = useState(1)
  const [version, setVersion] = useState(0)
  const [reconciling, setReconciling] = useState<LogisticsOrderRow | null>(null)
  const [importing, setImporting] = useState(false)
  const { data, error, loading, forbidden } = useLogistics(range.from, range.to, { orders: true, page, version })
  const refresh = () => setVersion((current) => current + 1)
  const orders = data?.orders
  const pages = orders ? Math.max(1, Math.ceil(orders.total / orders.pageSize)) : 1

  return (
    <div className="space-y-6 p-4 sm:p-6 lg:p-8">
      <AdminPageHeader title="Logística" description="Seguimiento de envíos Andreani, costos y conciliación en el período seleccionado." />
      {forbidden ? <p role="alert" className="text-sm font-bold text-red-300">Sólo Admin puede ver la logística.</p> : null}
      <div className="flex flex-wrap items-end justify-between gap-4 rounded-2xl border border-beyonix-blue-light/16 bg-[rgba(3,7,13,0.72)] p-4 sm:p-5">
        <LogisticsRangeFilter from={range.from} to={range.to} onChange={(next) => { setRange(next); setPage(1) }} />
        {!forbidden ? <AdminButton icon={<FileUp className="size-4" />} onClick={() => setImporting(true)}>Importar facturación (CSV)</AdminButton> : null}
      </div>
      {error ? <p role="alert" className="text-sm font-bold text-red-300">{error}</p> : null}
      {data ? <LogisticsSummaryGrid summary={data.summary} page /> : loading ? <p role="status" className="text-sm text-white/60">Cargando logística…</p> : null}
      {!forbidden ? <UnmatchedBillingList from={range.from} to={range.to} version={version} onChanged={refresh} /> : null}
      {orders ? (
        <AdminSection title="Pedidos Andreani" eyebrow="04 · Detalle" description="Seguimiento por pedido. Abrí el detalle para ver importes técnicos y conciliar." className="admin-logistics-table-card">
          {orders.rows.length ? <div className="overflow-x-auto rounded-xl border border-white/8">
            <table className="w-full min-w-[1120px] border-collapse text-left">
              <thead>
                <tr className="bg-white/[0.04] text-10px font-black uppercase tracking-widest text-white/60">
                  {COLUMNS.map((column) => (
                    <th key={column.label} scope="col" className="whitespace-nowrap px-3 py-2.5">
                      <span className="inline-flex items-center gap-1">{column.label}{column.help ? <AdminHelpTip label={column.label} text={column.help} /> : null}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {orders.rows.map((row) => <LogisticsOrderTableRow key={row.id} row={row} onReconcile={setReconciling} />)}
              </tbody>
            </table>
          </div> : <AdminEmptyState icon={<PackageSearch className="size-6" />} title="No hay pedidos Andreani en el período seleccionado" description="Probá cambiar el rango de fechas o importar la facturación para conciliar datos." />}
          {orders.rows.length ? <div className="flex items-center justify-between gap-2 pt-4 text-xs text-white/60">
            <span>{orders.total} pedidos · página {page} de {pages}</span>
            <span className="flex gap-2">
              <AdminButton size="sm" disabled={page <= 1 || loading} onClick={() => setPage((current) => current - 1)}>Anterior</AdminButton>
              <AdminButton size="sm" disabled={page >= pages || loading} onClick={() => setPage((current) => current + 1)}>Siguiente</AdminButton>
            </span>
          </div> : null}
        </AdminSection>
      ) : null}
      <ReconcileOrderModal row={reconciling} onClose={() => setReconciling(null)} onSaved={refresh} />
      <BillingImportModal open={importing} onClose={() => setImporting(false)} onImported={refresh} />
    </div>
  )
}
