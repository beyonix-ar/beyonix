"use client"

import type { SearchReport, SearchTerm } from "@/lib/analytics/commerce-report"
import type { AnalyticsDateRange } from "@/lib/analytics/product-view-report"

import { AdminHelpTip } from "../../components/admin-help-tip"
import { AdminSkeleton } from "../../components/admin-controls"
import { useAnalyticsReport, type AnalyticsReportState } from "./use-analytics-report"

const countFormatter = new Intl.NumberFormat("es-AR")

const SEARCH_HELP =
  "Búsquedas ejecutadas en la tienda (Enter, botón o sugerencia; escribir no cuenta), en minúsculas y sin espacios repetidos. No se guardan búsquedas que parecen datos personales (emails, teléfonos, documentos, tarjetas). Sin resultados: no había productos publicados que coincidieran al buscar."

export function useSearchReport(range: AnalyticsDateRange | null, rangeKey: string | null) {
  return useAnalyticsReport<SearchReport>("/api/admin/analytics/searches", "No se pudieron cargar las búsquedas.", range, rangeKey)
}

function TermList({ id, title, terms, empty }: { id: string; title: string; terms: SearchTerm[]; empty: string }) {
  return (
    <div className="min-w-0">
      <h3 id={id} className="mb-2 text-xs font-black uppercase tracking-widest text-white/52">{title}</h3>
      {terms.length > 0 ? (
        <ol className="admin-analytics-search-list" aria-labelledby={id}>
          {terms.map((entry, index) => (
            <li key={entry.term} className="admin-analytics-search-row">
              <span className="font-black tabular-nums text-white/55">{index + 1}</span>
              <span className="min-w-0 truncate text-sm font-bold text-white" title={entry.term}>{entry.term}</span>
              <span className="text-right text-sm font-black tabular-nums text-white">{countFormatter.format(entry.searches)}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-xs font-semibold text-white/55">{empty}</p>
      )}
    </div>
  )
}

/** Totales y rankings de búsquedas (top 10 y top 10 sin resultados). */
export function SearchSection({ report, loadError }: AnalyticsReportState<SearchReport>) {
  return (
    <section
      className="admin-dashboard-filters admin-analytics-search-section min-w-0 rounded-2xl border p-4"
      aria-labelledby="analytics-search-title"
      aria-busy={!report && !loadError}
    >
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 id="analytics-search-title" className="flex items-center gap-1 text-sm font-black text-white">
          Búsquedas
          <AdminHelpTip label="Búsquedas" text={SEARCH_HELP} />
        </h2>
        {report && (
          <p className="admin-analytics-search-totals text-xs font-semibold tabular-nums text-white/60">
            {countFormatter.format(report.totalSearches)} {report.totalSearches === 1 ? "búsqueda" : "búsquedas"} ·{" "}
            {countFormatter.format(report.searchSessions)} {report.searchSessions === 1 ? "sesión buscó" : "sesiones buscaron"}
          </p>
        )}
      </div>
      {report ? (
        <div className="grid min-w-0 gap-4 md:grid-cols-2">
          <TermList id="analytics-search-top" title="Top búsquedas" terms={report.top} empty="Sin búsquedas en este período" />
          <TermList
            id="analytics-search-zero"
            title="Búsquedas sin resultados"
            terms={report.withoutResults}
            empty={report.totalSearches > 0 ? "Todas las búsquedas tuvieron resultados" : "Sin búsquedas en este período"}
          />
        </div>
      ) : loadError ? (
        <p className="text-xs font-semibold text-white/55">{loadError}</p>
      ) : (
        <AdminSkeleton rows={3} />
      )}
    </section>
  )
}
