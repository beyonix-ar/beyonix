import { buildWeekdayViewsReport } from "@/lib/analytics/peak-views-report"
import { handleAnalyticsRpcRequest } from "@/lib/analytics/analytics-rpc-route"

/** Admin > Analítica > Visualizaciones por día de la semana. Sólo Admin y Super Admin; sólo el agregado. */
export async function GET(request: Request) {
  return handleAnalyticsRpcRequest(request, {
    rpc: "admin_product_views_by_weekday",
    errorMessage: "No se pudieron cargar las visualizaciones por día de la semana.",
    buildReport: (range, records) =>
      buildWeekdayViewsReport(range, records.map((record) => ({ weekday: Number(record.weekday), views: Number(record.view_count) }))),
  })
}
