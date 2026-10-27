import { handleAnalyticsRpcRequest, type AnalyticsRpcRecord } from "@/lib/analytics/analytics-rpc-route"
import { buildCommerceReport, type CommercePeriod } from "@/lib/analytics/commerce-report"
import { previousAnalyticsRange } from "@/lib/analytics/period-comparison"

const period = (record: AnalyticsRpcRecord | undefined): CommercePeriod | null =>
  record
    ? {
        viewedSessions: Number(record.viewed_sessions),
        cartSessions: Number(record.cart_sessions),
        checkoutSessions: Number(record.checkout_sessions),
        funnelCart: Number(record.funnel_cart),
        funnelCheckout: Number(record.funnel_checkout),
        funnelPurchase: Number(record.funnel_purchase),
        purchases: Number(record.purchases),
        attributedPurchases: Number(record.attributed_purchases),
        revenue: Number(record.revenue),
        attributedRevenue: Number(record.attributed_revenue),
        evaluatedCarts: Number(record.evaluated_carts),
        abandonedCarts: Number(record.abandoned_carts),
        abandonedCheckouts: Number(record.abandoned_checkouts),
        cartsInProgress: Number(record.carts_in_progress),
      }
    : null

/**
 * Admin > Analítica > Conversión: funnel, carritos/checkout, abandono y
 * compras del período y del anterior (que deriva el servidor), en una sola
 * consulta. Sólo Admin y Super Admin; sólo el agregado.
 */
export async function GET(request: Request) {
  return handleAnalyticsRpcRequest(request, {
    rpc: "admin_commerce_funnel",
    errorMessage: "No se pudo cargar la conversión.",
    rpcParams: (range) => {
      const previous = previousAnalyticsRange(range)
      return { p_previous_from: previous.from, p_previous_to: previous.to }
    },
    buildReport: (range, records) =>
      buildCommerceReport(range, {
        current: period(records.find((record) => record.period === "current")),
        previous: period(records.find((record) => record.period === "previous")),
      }),
  })
}
