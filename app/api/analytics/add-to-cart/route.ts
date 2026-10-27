import { handleAnalyticsBeacon } from "@/lib/analytics/beacon-route"
import { parseAddToCartPayload } from "@/lib/analytics/commerce-event"

/**
 * Beacon `add_to_cart`: una unidad agregada de verdad al carrito. Producto
 * activo y variante del producto se validan en `record_add_to_cart`; el id de
 * la acción hace idempotentes los reintentos y requests dobles.
 */
export async function POST(request: Request) {
  return handleAnalyticsBeacon(request, {
    event: "add_to_cart",
    parse: parseAddToCartPayload,
    rpc: "record_add_to_cart",
    args: (payload, context) => ({
      p_session_id: payload.sessionId,
      p_client_event_id: payload.eventId,
      p_product_id: payload.productId,
      p_variant_id: payload.variantId,
      p_user_id: context.userId,
      p_device_type: context.deviceType,
      p_client_key: context.clientKey,
    }),
  })
}
