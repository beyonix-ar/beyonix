import { requireInternalUser } from "@/lib/auth/admin-api"
import {
  buildProductViewReport,
  isValidAnalyticsRange,
  type ProductViewStatsRow,
} from "@/lib/analytics/product-view-report"

interface ProductViewStatsRecord {
  product_id: number | string
  product_name: string | null
  product_slug: string | null
  product_image: string | null
  views: number | string
}

/** Admin > Analítica > Productos más vistos. Sólo Admin y Super Admin; nunca eventos crudos. */
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

  const { data, error } = await auth.admin.rpc("admin_product_view_stats", {
    p_from: range.from,
    p_to: range.to,
  })
  if (error) {
    return Response.json(
      { error: "No se pudieron cargar las vistas de productos." },
      { status: 500 },
    )
  }

  const rows: ProductViewStatsRow[] = ((data ?? []) as ProductViewStatsRecord[]).map((row) => ({
    productId: Number(row.product_id),
    name: row.product_name ?? "Producto",
    slug: row.product_slug ?? "",
    image: row.product_image,
    views: Number(row.views),
  }))

  return Response.json(buildProductViewReport(range, rows), {
    headers: { "Cache-Control": "private, no-store" },
  })
}
