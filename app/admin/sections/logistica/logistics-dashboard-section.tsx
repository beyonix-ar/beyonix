"use client"

import { useState } from "react"
import Link from "next/link"
import { ArrowRight, Truck } from "lucide-react"

import {
  currentMonthRange,
  LogisticsRangeFilter,
  LogisticsSummaryGrid,
  useLogistics,
} from "./logistics-summary"

/** Dashboard → LOGÍSTICA ANDREANI. Sólo Admin: si la API responde 403, no se muestra. */
export function LogisticsDashboardSection({ hideAmounts }: { hideAmounts: boolean }) {
  const [range, setRange] = useState(currentMonthRange)
  const { data, error, loading, forbidden } = useLogistics(range.from, range.to)
  if (forbidden) return null

  const detailHref = `/admin/logistica?${new URLSearchParams(range)}`
  return (
    <section className="rounded-3xl border border-beyonix-blue-light/16 bg-[linear-gradient(145deg,rgba(7,16,24,0.78),rgba(3,7,13,0.92))] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.025)]" data-dashboard-logistics>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="flex items-center gap-1.5 text-11px font-bold uppercase tracking-widest text-beyonix-cyan">
            <Truck className="size-3.5" /> Envíos
          </p>
          <h2 className="text-xl font-black text-white">LOGÍSTICA ANDREANI</h2>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <LogisticsRangeFilter from={range.from} to={range.to} onChange={setRange} />
          <Link href={detailHref} className="admin-ds-button admin-ds-button-secondary inline-flex h-9 items-center gap-2 px-3 text-xs font-black">
            Ver logística <ArrowRight className="size-3.5" />
          </Link>
        </div>
      </div>
      {error ? <p role="alert" className="text-sm font-bold text-red-300">{error}</p> : null}
      {data ? <LogisticsSummaryGrid summary={data.summary} hideAmounts={hideAmounts} /> : loading ? <p role="status" className="text-sm text-white/60">Cargando logística…</p> : null}
    </section>
  )
}
