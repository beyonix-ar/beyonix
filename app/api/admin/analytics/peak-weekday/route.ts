import { buildPeakWeekdayReport } from "@/lib/analytics/peak-views-report"
import { handlePeakViewsRequest } from "@/lib/analytics/peak-views-route"

/** Admin > Analítica > Día con más visualizaciones. Sólo Admin y Super Admin; sólo el agregado. */
export async function GET(request: Request) {
  return handlePeakViewsRequest(request, {
    rpc: "admin_product_view_peak_weekday",
    bucketColumn: "peak_weekday",
    errorMessage: "No se pudo cargar el día con más visualizaciones.",
    buildReport: buildPeakWeekdayReport,
  })
}
