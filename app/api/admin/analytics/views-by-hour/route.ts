import { buildHourlyViewsReport } from "@/lib/analytics/peak-views-report"
import { handleAnalyticsRpcRequest } from "@/lib/analytics/analytics-rpc-route"

/** Admin > Analítica > Visualizaciones por hora del día. Sólo Admin y Super Admin; sólo el agregado. */
export async function GET(request: Request) {
  return handleAnalyticsRpcRequest(request, {
    rpc: "admin_product_views_by_hour",
    errorMessage: "No se pudieron cargar las visualizaciones por hora del día.",
    buildReport: (range, records) =>
      buildHourlyViewsReport(range, records.map((record) => ({ hour: Number(record.hour), views: Number(record.view_count) }))),
  })
}
