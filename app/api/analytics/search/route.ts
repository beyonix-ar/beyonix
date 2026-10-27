import { handleAnalyticsBeacon } from "@/lib/analytics/beacon-route"
import { parseSearchPayload } from "@/lib/analytics/commerce-event"

/**
 * Beacon `search`: búsqueda ejecutada en la tienda. El servidor vuelve a
 * normalizar y descarta texto que parezca un dato sensible (204 sin guardar);
 * la cantidad de resultados la calcula `record_search`, nunca el cliente.
 */
export async function POST(request: Request) {
  return handleAnalyticsBeacon(request, {
    event: "search",
    parse: parseSearchPayload,
    rpc: "record_search",
    args: (payload, context) => ({
      p_session_id: payload.sessionId,
      p_client_event_id: payload.eventId,
      p_query: payload.query,
      p_user_id: context.userId,
      p_device_type: context.deviceType,
      p_client_key: context.clientKey,
    }),
  })
}
