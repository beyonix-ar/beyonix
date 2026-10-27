import { handleAnalyticsBeacon } from "@/lib/analytics/beacon-route"
import { parseCheckoutStartedPayload } from "@/lib/analytics/commerce-event"

/**
 * Beacon `checkout_started`: entrada real al checkout con carrito válido. Uno
 * por sesión de Analítica (índice único en la base): recargar o reintentar no
 * suma.
 */
export async function POST(request: Request) {
  return handleAnalyticsBeacon(request, {
    event: "checkout_started",
    parse: parseCheckoutStartedPayload,
    rpc: "record_checkout_started",
    args: (payload, context) => ({
      p_session_id: payload.sessionId,
      p_user_id: context.userId,
      p_device_type: context.deviceType,
      p_client_key: context.clientKey,
    }),
  })
}
