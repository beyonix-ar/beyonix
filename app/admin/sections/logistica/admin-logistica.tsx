"use client"

import { useState } from "react"
import { useSearchParams } from "next/navigation"

import { AdminHelpTip } from "@/app/admin/components/admin-help-tip"
import { AdminButton, AdminPageHeader } from "@/app/admin/components/admin-controls"
import type { LogisticsOrderRow } from "@/lib/admin/logistics"
import {
  BILLING_PENDING_LABEL,
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
  { label: "Facturado Andreani", help: LOGISTICS_HELP.billed },
  { label: "Conciliación", help: LOGISTICS_HELP.reconciliation },
]

function Row({ row }: { row: LogisticsOrderRow }) {
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
      <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{row.billed === null ? <span className="text-white/55">Pendiente</span> : formatMoney(row.billed)}</td>
      <td className="whitespace-nowrap px-3 py-2">{row.reconciliation === "reconciled" ? "Conciliado" : BILLING_PENDING_LABEL}</td>
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
  const { data, error, loading, forbidden } = useLogistics(range.from, range.to, { orders: true, page })
  const orders = data?.orders
  const pages = orders ? Math.max(1, Math.ceil(orders.total / orders.pageSize)) : 1

  return (
    <div className="space-y-4 p-4 sm:p-6 lg:p-8">
      <AdminPageHeader title="Logística" description="Envíos Andreani: cotizado en checkout, recargo logístico, bultos reales y conciliación." />
      {forbidden ? <p role="alert" className="text-sm font-bold text-red-300">Sólo Admin puede ver la logística.</p> : null}
      <LogisticsRangeFilter from={range.from} to={range.to} onChange={(next) => { setRange(next); setPage(1) }} />
      {error ? <p role="alert" className="text-sm font-bold text-red-300">{error}</p> : null}
      {data ? <LogisticsSummaryGrid summary={data.summary} /> : loading ? <p role="status" className="text-sm text-white/60">Cargando logística…</p> : null}
      {orders ? (
        <section className="admin-logistics-table-card overflow-hidden rounded-2xl border border-beyonix-blue-light/16 bg-[rgba(3,7,13,0.72)]">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1100px] border-collapse text-left">
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
                  ? orders.rows.map((row) => <Row key={row.id} row={row} />)
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
    </div>
  )
}
