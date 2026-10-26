import { buildPeakHourReport } from "@/lib/analytics/peak-views-report"
import { handlePeakViewsRequest } from "@/lib/analytics/peak-views-route"

/** Admin > Analítica > Horario pico de visualizaciones. Sólo Admin y Super Admin; sólo el agregado. */
export async function GET(request: Request) {
  return handlePeakViewsRequest(request, {
    rpc: "admin_product_view_peak_hour",
    bucketColumn: "peak_hour",
    errorMessage: "No se pudo cargar el horario pico de visualizaciones.",
    buildReport: buildPeakHourReport,
  })
}
