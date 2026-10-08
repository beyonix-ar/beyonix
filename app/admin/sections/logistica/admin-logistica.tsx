"use client"

import { useState } from "react"
import { FileUp } from "lucide-react"
import { useSearchParams } from "next/navigation"

import { AdminHelpTip } from "@/app/admin/components/admin-help-tip"
import { AdminButton, AdminPageHeader } from "@/app/admin/components/admin-controls"
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
  { label: "Bultos" },
  { label: "Tarifa checkout", help: LOGISTICS_HELP.providerQuoted },
  { label: "Recargo %", help: LOGISTICS_HELP.markupPercent },
  { label: "Extra cobrado", help: LOGISTICS_HELP.markup },
  { label: "Beneficio", help: LOGISTICS_HELP.benefit },
  { label: "Cobrado cliente", help: LOGISTICS_HELP.charged },
  { label: "Cotizado con bulto real", help: LOGISTICS_HELP.parcelQuoted },
  { label: "Diferencia", help: LOGISTICS_HELP.difference },
  { label: "Facturado Andreani", help: BILLED_HELP },
  { label: "Dif. vs checkout", help: LOGISTICS_HELP.billedVsCheckout },
  { label: "Dif. vs armado", help: LOGISTICS_HELP.billedVsParcel },
  { label: "Estado conciliación", help: LOGISTICS_HELP.reconciliation },
  { label: "Referencia" },
  { label: "Acción" },
]

function Row({ row, onReconcile }: { row: LogisticsOrderRow; onReconcile: (row: LogisticsOrderRow) => void }) {
  return (
    <tr className="border-t border-white/8 text-sm text-white/85">
      <td className="whitespace-nowrap px-3 py-2 font-black text-white">{row.code}</td>
      <td className="whitespace-nowrap px-3 py-2">{formatDate(row.createdAt)}</td>
      <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">{row.tracking ?? "—"}</td>
      <td className="whitespace-nowrap px-3 py-2">{row.status}</td>
      <td className="px-3 py-2 text-right tabular-nums">{row.parcels ?? "—"}</td>
      <td className="px-3 py-2 text-right tabular-nums">{money(row.checkoutQuote)}</td>
      <td className="px-3 py-2 text-right tabular-nums">{row.markupPercent === null ? "—" : `${new Intl.NumberFormat("es-AR", { maximumFractionDigits: 2 }).format(row.markupPercent)}%`}</td>
      <td className="px-3 py-2 text-right tabular-nums">{money(row.markupAmount)}</td>
      <td className="px-3 py-2 text-right tabular-nums">{money(row.benefit)}</td>
      <td className="px-3 py-2 text-right tabular-nums">{money(row.chargedToCustomer)}</td>
      <td className="px-3 py-2 text-right tabular-nums">{money(row.parcelQuote)}</td>
      <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{row.difference === null ? "—" : <>{formatSignedMoney(row.difference)}{row.differencePercent === null ? null : <span className="block text-xs text-white/60">{formatSignedPercent(row.differencePercent)}</span>}</>}</td>
      <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{row.billedOutbound === null && row.billedTotal === null ? <span className="text-white/55">Pendiente</span> : <>{money(row.billedOutbound)}{row.billedTotal !== null && row.billedTotal !== row.billedOutbound ? <span className="block text-xs text-white/60">Total {formatMoney(row.billedTotal)}</span> : null}</>}</td>
      <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{signedOrDash(row.billedVsCheckout)}</td>
      <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{signedOrDash(row.billedVsParcel)}</td>
      <td className="whitespace-nowrap px-3 py-2"><ReconciliationBadge status={row.reconciliation} /></td>
      <td className="max-w-[180px] truncate px-3 py-2 font-mono text-xs" title={row.references ?? undefined}>{row.references ?? "—"}</td>
      <td className="whitespace-nowrap px-3 py-2"><AdminButton size="sm" onClick={() => onReconcile(row)}>Conciliar</AdminButton></td>
    </tr>
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
    <div className="space-y-4 p-4 sm:p-6 lg:p-8">
      <AdminPageHeader title="Logística" description="Envíos Andreani: cotizado en checkout, recargo logístico, bultos reales y conciliación." />
      {forbidden ? <p role="alert" className="text-sm font-bold text-red-300">Sólo Admin puede ver la logística.</p> : null}
      <div className="flex flex-wrap items-end justify-between gap-2">
        <LogisticsRangeFilter from={range.from} to={range.to} onChange={(next) => { setRange(next); setPage(1) }} />
        {!forbidden ? <AdminButton icon={<FileUp className="size-4" />} onClick={() => setImporting(true)}>Importar facturación (CSV)</AdminButton> : null}
      </div>
      {error ? <p role="alert" className="text-sm font-bold text-red-300">{error}</p> : null}
      {data ? <LogisticsSummaryGrid summary={data.summary} /> : loading ? <p role="status" className="text-sm text-white/60">Cargando logística…</p> : null}
      {!forbidden ? <UnmatchedBillingList from={range.from} to={range.to} version={version} onChanged={refresh} /> : null}
      {orders ? (
        <section className="admin-logistics-table-card overflow-hidden rounded-2xl border border-beyonix-blue-light/16 bg-[rgba(3,7,13,0.72)]">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1500px] border-collapse text-left">
              <thead>
                <tr className="text-10px font-black uppercase tracking-widest text-white/55">
                  {COLUMNS.map((column) => (
                    <th key={column.label} scope="col" className="whitespace-nowrap px-3 py-2.5">
                      <span className="inline-flex items-center gap-1">{column.label}{column.help ? <AdminHelpTip label={column.label} text={column.help} /> : null}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {orders.rows.length
                  ? orders.rows.map((row) => <Row key={row.id} row={row} onReconcile={setReconciling} />)
                  : <tr><td colSpan={COLUMNS.length} className="px-3 py-6 text-center text-sm text-white/60">No hay pedidos Andreani en el período.</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between gap-2 border-t border-white/8 px-3 py-2 text-xs text-white/60">
            <span>{orders.total} pedidos · página {page} de {pages}</span>
            <span className="flex gap-2">
              <AdminButton size="sm" disabled={page <= 1 || loading} onClick={() => setPage((current) => current - 1)}>Anterior</AdminButton>
              <AdminButton size="sm" disabled={page >= pages || loading} onClick={() => setPage((current) => current + 1)}>Siguiente</AdminButton>
            </span>
          </div>
        </section>
      ) : null}
      <ReconcileOrderModal row={reconciling} onClose={() => setReconciling(null)} onSaved={refresh} />
      <BillingImportModal open={importing} onClose={() => setImporting(false)} onImported={refresh} />
    </div>
  )
}
