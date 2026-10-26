import { formatSharePercent, type ProductViewRankingEntry } from "@/lib/analytics/product-view-report"

const viewsFormatter = new Intl.NumberFormat("es-AR")

/**
 * Top 10 en barras horizontales: una sola serie (vistas), así que un solo
 * tono y sin leyenda; el título del panel nombra la serie. El nombre va
 * arriba de cada barra para que entre en mobile sin scroll horizontal, y el
 * valor en la punta. Hover/foco muestra la participación del total.
 */
export function ProductViewsChart({ entries }: { entries: ProductViewRankingEntry[] }) {
  const top = entries.slice(0, 10)
  const max = top[0]?.views ?? 0

  return (
    <ol className="admin-analytics-chart space-y-2.5" aria-label="Top 10 productos por vistas">
      {top.map((entry) => {
        const share = formatSharePercent(entry.sharePercent)
        const label = `${entry.name}: ${viewsFormatter.format(entry.views)} ${entry.views === 1 ? "vista" : "vistas"}, ${share} del total`
        return (
          <li key={entry.productId} className="admin-analytics-bar-row" tabIndex={0} aria-label={label}>
            <div className="flex min-w-0 items-baseline justify-between gap-3 text-xs">
              <span className="min-w-0 truncate font-bold text-white/82" title={entry.name}>
                {entry.name}
              </span>
              <span className="shrink-0 font-black tabular-nums text-white">
                {viewsFormatter.format(entry.views)}
              </span>
            </div>
            <div className="admin-analytics-bar-track mt-1">
              <span
                className="admin-analytics-bar"
                style={{ width: `${max > 0 ? Math.max((entry.views / max) * 100, 1.5) : 0}%` }}
              />
              <span className="admin-analytics-bar-tooltip" role="presentation">
                {share} del total
              </span>
            </div>
          </li>
        )
      })}
    </ol>
  )
}
