import { handleAnalyticsBeacon } from "@/lib/analytics/beacon-route"
import { parseProductViewPayload } from "@/lib/analytics/product-view-event"

/**
 * Beacon `product_view` de la tienda: producto validado en la base (existe y
 * está activo); deduplicación y límites en `record_product_view`. Usuario,
 * equipo interno, robots y respuestas: ver handleAnalyticsBeacon.
 */
export async function POST(request: Request) {
  return handleAnalyticsBeacon(request, {
    event: "product_view",
    parse: parseProductViewPayload,
    rpc: "record_product_view",
    args: (payload, context) => ({
      p_session_id: payload.sessionId,
      p_product_id: payload.productId,
      p_user_id: context.userId,
      p_source: payload.source,
      p_device_type: context.deviceType,
      p_client_key: context.clientKey,
    }),
  })
}
