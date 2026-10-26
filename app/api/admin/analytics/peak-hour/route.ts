import { requireInternalUser } from "@/lib/auth/admin-api"
import { buildPeakHourReport } from "@/lib/analytics/peak-hour-report"
import { isValidAnalyticsRange } from "@/lib/analytics/product-view-report"

interface PeakHourRecord {
  peak_hour: number | string
  peak_views: number | string
  total_views: number | string
}

/** Admin > Analítica > Horario pico de visualizaciones. Sólo Admin y Super Admin; sólo el agregado. */
export async function GET(request: Request) {
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

  const { data, error } = await auth.admin.rpc("admin_product_view_peak_hour", {
    p_from: range.from,
    p_to: range.to,
  })
  if (error) {
    return Response.json(
      { error: "No se pudo cargar el horario pico de visualizaciones." },
      { status: 500 },
    )
  }

  const record = ((data ?? []) as PeakHourRecord[])[0]
  const row = record
    ? { hour: Number(record.peak_hour), views: Number(record.peak_views), totalViews: Number(record.total_views) }
    : null

  return Response.json(buildPeakHourReport(range, row), {
    headers: { "Cache-Control": "private, no-store" },
  })
}
