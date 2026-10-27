import { handleAnalyticsRpcRequest, type AnalyticsRpcRecord } from "@/lib/analytics/analytics-rpc-route"
import { buildPeriodComparisonReport, previousAnalyticsRange } from "@/lib/analytics/period-comparison"

const counts = (record: AnalyticsRpcRecord, period: "current" | "previous") => ({
  totalViews: Number(record[`${period}_total_views`]),
  productsViewed: Number(record[`${period}_products_viewed`]),
  sessions: Number(record[`${period}_sessions`]),
})

/**
 * Admin > Analítica > comparación con el período anterior. El período anterior
 * lo deriva el servidor del rango validado. Sólo Admin y Super Admin; sólo el agregado.
 */
export async function GET(request: Request) {
  return handleAnalyticsRpcRequest(request, {
    rpc: "admin_product_view_period_comparison",
    errorMessage: "No se pudo cargar la comparación con el período anterior.",
    rpcParams: (range) => {
      const previous = previousAnalyticsRange(range)
      return { p_previous_from: previous.from, p_previous_to: previous.to }
    },
    buildReport: (range, records) => {
      const record = records[0]
      return buildPeriodComparisonReport(range, record ? { current: counts(record, "current"), previous: counts(record, "previous") } : null)
    },
  })
}
