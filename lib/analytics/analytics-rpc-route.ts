import { requireInternalUser } from "@/lib/auth/admin-api"
import { isValidAnalyticsRange, type AnalyticsDateRange } from "@/lib/analytics/product-view-report"
import type { PeakViewsRow } from "@/lib/analytics/peak-views-report"

/** Fila cruda de una RPC agregada de Analítica (bigint puede llegar como string). */
export type AnalyticsRpcRecord = Record<string, number | string | null>

interface AnalyticsRpcEndpoint<Report> {
  rpc: "admin_product_view_peak_hour" | "admin_product_view_peak_weekday" | "admin_product_views_by_weekday" | "admin_product_views_by_hour"
  errorMessage: string
  buildReport: (range: AnalyticsDateRange, records: AnalyticsRpcRecord[]) => Report
}

/**
 * GET de una métrica agregada de Admin > Analítica: sólo Admin y Super Admin,
 * mismo período validado que Productos más vistos y sólo el agregado.
 */
export async function handleAnalyticsRpcRequest<Report>(request: Request, endpoint: AnalyticsRpcEndpoint<Report>) {
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

  return Response.json(endpoint.buildReport(range, (data ?? []) as AnalyticsRpcRecord[]), {
    headers: { "Cache-Control": "private, no-store" },
  })
}

/** Fila ganadora de una RPC "pico" (`bucketColumn` = franja/día), o `null` si no hubo vistas. */
export function peakViewsRow(records: AnalyticsRpcRecord[], bucketColumn: "peak_hour" | "peak_weekday"): PeakViewsRow | null {
  const record = records[0]
  return record
    ? { bucket: Number(record[bucketColumn]), views: Number(record.peak_views), totalViews: Number(record.total_views) }
    : null
}
