import { handleAnalyticsRpcRequest } from "@/lib/analytics/analytics-rpc-route"
import { buildSearchReport } from "@/lib/analytics/commerce-report"

/** Admin > Analítica > Búsquedas: totales, top 10 y top 10 sin resultados. Sólo Admin y Super Admin. */
export async function GET(request: Request) {
  return handleAnalyticsRpcRequest(request, {
    rpc: "admin_search_stats",
    errorMessage: "No se pudieron cargar las búsquedas.",
    buildReport: (range, records) =>
      buildSearchReport(range, records.map((record) => ({
        kind: String(record.kind),
        term: typeof record.term === "string" ? record.term : null,
        searches: Number(record.searches),
        sessions: Number(record.sessions),
      }))),
  })
}
