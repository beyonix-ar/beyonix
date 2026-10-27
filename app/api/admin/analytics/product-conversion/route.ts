import { handleAnalyticsRpcRequest } from "@/lib/analytics/analytics-rpc-route"
import { buildProductConversionReport } from "@/lib/analytics/commerce-report"

/** Admin > Analítica > Conversión por producto (sesiones únicas). Sólo Admin y Super Admin. */
export async function GET(request: Request) {
  return handleAnalyticsRpcRequest(request, {
    rpc: "admin_product_conversion",
    errorMessage: "No se pudo cargar la conversión por producto.",
    buildReport: (range, records) =>
      buildProductConversionReport(range, records.map((record) => ({
        productId: Number(record.product_id),
        name: typeof record.product_name === "string" ? record.product_name : "Producto",
        slug: typeof record.product_slug === "string" ? record.product_slug : "",
        image: typeof record.product_image === "string" ? record.product_image : null,
        available: record.product_available === true,
        viewedSessions: Number(record.viewed_sessions),
        addedSessions: Number(record.added_sessions),
        purchasedSessions: Number(record.purchased_sessions),
      }))),
  })
}
