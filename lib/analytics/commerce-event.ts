import { normalizeSearchQuery } from "./search-query.ts"

/**
 * Validación server-side de los beacons comerciales (add_to_cart, search,
 * checkout_started). Igual que product_view: el cliente sólo aporta lo que no
 * puede derivarse en el servidor (sesión anónima, id de la acción y qué hizo);
 * usuario, dispositivo, origen, resultados de búsqueda y precios nunca se
 * toman del payload. Los campos extra (p. ej. `userId`, `orderId`) se ignoran.
 */

export const COMMERCE_EVENT_MAX_BODY_BYTES = 1_024

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export const isUuid = (value: unknown): value is string => typeof value === "string" && UUID_PATTERN.test(value)

const isPositiveId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0

/** Objeto JSON acotado, o `null`. */
export function parseBeaconBody(raw: string, maxBytes = COMMERCE_EVENT_MAX_BODY_BYTES): Record<string, unknown> | null {
  if (!raw || raw.length > maxBytes) return null
  try {
    const body: unknown = JSON.parse(raw)
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export interface AddToCartPayload {
  sessionId: string
  eventId: string
  productId: number
  variantId: number | null
}

export function parseAddToCartPayload(raw: string): AddToCartPayload | null {
  const body = parseBeaconBody(raw)
  if (!body) return null
  const { sessionId, eventId, productId, variantId } = body
  if (!isUuid(sessionId) || !isUuid(eventId) || !isPositiveId(productId)) return null
  if (variantId !== undefined && variantId !== null && !isPositiveId(variantId)) return null
  return { sessionId: sessionId.toLowerCase(), eventId: eventId.toLowerCase(), productId, variantId: variantId ?? null }
}

export interface SearchPayload {
  sessionId: string
  eventId: string
  /** Normalizada y sin datos sensibles. */
  query: string
}

/** `null` si el payload es inválido; `"skip"` si la búsqueda es válida pero no se registra (vacía o sensible). */
export function parseSearchPayload(raw: string): SearchPayload | "skip" | null {
  const body = parseBeaconBody(raw)
  if (!body) return null
  const { sessionId, eventId, query } = body
  if (!isUuid(sessionId) || !isUuid(eventId) || typeof query !== "string") return null
  const normalized = normalizeSearchQuery(query)
  if (!normalized) return "skip"
  return { sessionId: sessionId.toLowerCase(), eventId: eventId.toLowerCase(), query: normalized }
}

export interface CheckoutStartedPayload {
  sessionId: string
}

export function parseCheckoutStartedPayload(raw: string): CheckoutStartedPayload | null {
  const body = parseBeaconBody(raw)
  if (!body || !isUuid(body.sessionId)) return null
  return { sessionId: body.sessionId.toLowerCase() }
}
