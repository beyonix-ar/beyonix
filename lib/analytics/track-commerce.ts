import { createAnalyticsSessionId, readAnalyticsSession, touchAnalyticsSession } from "./analytics-session"
import { getBrowserAnalyticsStore, type AnalyticsStore } from "./analytics-storage"
import { ADD_TO_CART_ENDPOINT, CHECKOUT_STARTED_ENDPOINT, SEARCH_ENDPOINT } from "./events"
import { normalizeSearchQuery } from "./search-query"
import { getAccessToken } from "./track-product-view"

const SEND_TIMEOUT_MS = 5_000

/**
 * Beacons comerciales del navegador. Igual que product_view: nunca lanzan,
 * nunca se esperan y cualquier fallo (red, storage, auth, servidor) se
 * descarta: Analítica jamás interfiere con agregar, buscar o pagar. El token
 * sólo viaja para que el servidor identifique al usuario por su cuenta; el
 * payload no lleva datos de usuario, precios ni resultados.
 */
async function sendBeacon(endpoint: string, body: Record<string, unknown>) {
  try {
    const token = await getAccessToken()
    await fetch(endpoint, {
      method: "POST",
      keepalive: true,
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    })
  } catch {
    // Analítica nunca interfiere con la navegación ni con la compra.
  }
}

/**
 * Una unidad agregada de verdad al carrito. Cada llamada es una acción real
 * con su propio id (idempotencia técnica en el servidor): llamarla SÓLO cuando
 * el carrito efectivamente aumentó, fuera de cualquier updater de estado.
 */
export function trackAddToCart(productId: number, variantId: number | null) {
  try {
    const session = touchAnalyticsSession()
    const eventId = createAnalyticsSessionId()
    if (!session || !eventId) return
    void sendBeacon(ADD_TO_CART_ENDPOINT, { sessionId: session.id, eventId, productId, variantId })
  } catch {
    // Sin storage ni Web Crypto: no se mide.
  }
}

/** Búsqueda ejecutada. Vacía o con datos que parecen sensibles: no se envía. */
export function trackSearch(rawQuery: string) {
  try {
    const query = normalizeSearchQuery(rawQuery)
    if (!query) return
    const session = touchAnalyticsSession()
    const eventId = createAnalyticsSessionId()
    if (!session || !eventId) return
    void sendBeacon(SEARCH_ENDPOINT, { sessionId: session.id, eventId, query })
  } catch {
    // Sin storage ni Web Crypto: no se mide.
  }
}

const CHECKOUT_SENT_KEY = "beyonix-analytics-checkout-started"

function isSentMarker(value: unknown): value is { sessionId: string } {
  return Boolean(value) && typeof (value as { sessionId?: unknown }).sessionId === "string"
}

/**
 * Entrada real al checkout con carrito válido. Uno por sesión de Analítica:
 * la base lo garantiza; este marcador sólo evita requests que se descartarían
 * (recargar, volver al checkout, re-renders).
 */
export function trackCheckoutStarted(store: AnalyticsStore = getBrowserAnalyticsStore()) {
  try {
    const session = touchAnalyticsSession(Date.now(), store)
    if (!session) return
    if (store.read(CHECKOUT_SENT_KEY, isSentMarker)?.sessionId === session.id) return
    store.write(CHECKOUT_SENT_KEY, { sessionId: session.id })
    void sendBeacon(CHECKOUT_STARTED_ENDPOINT, { sessionId: session.id })
  } catch {
    // Sin storage: no se mide.
  }
}

/** Sesión de Analítica vigente para atribuir la orden que se crea (nunca la de reserva de stock). */
export function currentAnalyticsSessionId() {
  try {
    return readAnalyticsSession()?.id ?? null
  } catch {
    return null
  }
}
