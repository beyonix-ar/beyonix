import { buildPeakWeekdayReport } from "@/lib/analytics/peak-views-report"
import { handleAnalyticsRpcRequest, peakViewsRow } from "@/lib/analytics/analytics-rpc-route"

/** Admin > Analítica > Día con más visualizaciones. Sólo Admin y Super Admin; sólo el agregado. */
export async function GET(request: Request) {
  return handleAnalyticsRpcRequest(request, {
    rpc: "admin_product_view_peak_weekday",
    errorMessage: "No se pudo cargar el día con más visualizaciones.",
    buildReport: (range, records) => buildPeakWeekdayReport(range, peakViewsRow(records, "peak_weekday")),
  })
}
