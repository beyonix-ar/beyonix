import { buildPeakHourReport } from "@/lib/analytics/peak-views-report"
import { handleAnalyticsRpcRequest, peakViewsRow } from "@/lib/analytics/analytics-rpc-route"

/** Admin > Analítica > Horario pico de visualizaciones. Sólo Admin y Super Admin; sólo el agregado. */
export async function GET(request: Request) {
  return handleAnalyticsRpcRequest(request, {
    rpc: "admin_product_view_peak_hour",
    errorMessage: "No se pudo cargar el horario pico de visualizaciones.",
    buildReport: (range, records) => buildPeakHourReport(range, peakViewsRow(records, "peak_hour")),
  })
}
