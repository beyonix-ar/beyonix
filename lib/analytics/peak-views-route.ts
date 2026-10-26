import { requireInternalUser } from "@/lib/auth/admin-api"
import { isValidAnalyticsRange, type AnalyticsDateRange } from "@/lib/analytics/product-view-report"
import type { PeakViewsRow } from "@/lib/analytics/peak-views-report"

type PeakViewsRecord = Record<string, number | string | null>

interface PeakViewsEndpoint<Report> {
  rpc: "admin_product_view_peak_hour" | "admin_product_view_peak_weekday"
  /** Columna de la RPC con la franja/día ganador. */
  bucketColumn: "peak_hour" | "peak_weekday"
  errorMessage: string
  buildReport: (range: AnalyticsDateRange, row: PeakViewsRow | null) => Report
}

/**
 * GET de una métrica "pico" de Admin > Analítica: sólo Admin y Super Admin,
 * mismo período validado que Productos más vistos y sólo el agregado.
 */
export async function handlePeakViewsRequest<Report>(request: Request, endpoint: PeakViewsEndpoint<Report>) {
  const auth = await requireInternalUser(request, ["admin", "super_admin"])
  if ("error" in auth) return auth.error

  const url = new URL(request.url)
  const range = {
    from: url.searchParams.get("from") ?? "",
    to: url.searchParams.get("to") ?? "",
  }
  if (!isValidAnalyticsRange(range)) {
    return Response.json({ error: "Elegí un rango de fechas válido." }, { status: 400 })
  }

  const { data, error } = await auth.admin.rpc(endpoint.rpc, {
    p_from: range.from,
    p_to: range.to,
  })
  if (error) {
    return Response.json({ error: endpoint.errorMessage }, { status: 500 })
  }

  const record = ((data ?? []) as PeakViewsRecord[])[0]
  const row = record
    ? { bucket: Number(record[endpoint.bucketColumn]), views: Number(record.peak_views), totalViews: Number(record.total_views) }
    : null

  return Response.json(endpoint.buildReport(range, row), {
    headers: { "Cache-Control": "private, no-store" },
  })
}
