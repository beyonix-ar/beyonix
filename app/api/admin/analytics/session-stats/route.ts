import { handleAnalyticsRpcRequest } from "@/lib/analytics/analytics-rpc-route"
import { buildSessionStatsReport } from "@/lib/analytics/session-stats-report"

/** Admin > Analítica > Sesiones con visualizaciones. Sólo Admin y Super Admin; sólo el agregado. */
export async function GET(request: Request) {
  return handleAnalyticsRpcRequest(request, {
    rpc: "admin_product_view_session_stats",
    errorMessage: "No se pudieron cargar las sesiones con visualizaciones.",
    buildReport: (range, records) => {
      const record = records[0]
      return buildSessionStatsReport(range, record ? { totalViews: Number(record.total_views), sessions: Number(record.unique_sessions) } : null)
    },
  })
}
