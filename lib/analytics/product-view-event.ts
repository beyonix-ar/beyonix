import { createHmac } from "node:crypto"

import { PRODUCT_VIEW_SOURCES, type ProductViewSource } from "./events.ts"

/**
 * Validación server-side del beacon `product_view`. El cliente sólo aporta lo
 * que no puede derivarse en el servidor (sesión anónima, producto y dónde se
 * abrió); usuario, dispositivo y origen se resuelven acá y nunca se toman del
 * payload.
 */

export type DeviceType = "mobile" | "tablet" | "desktop"

export const PRODUCT_VIEW_MAX_BODY_BYTES = 1_024

export interface ProductViewPayload {
  sessionId: string
  productId: number
  source: ProductViewSource
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isProductViewSource(value: unknown): value is ProductViewSource {
  return PRODUCT_VIEW_SOURCES.includes(value as ProductViewSource)
}

/** `null` si el body no es exactamente un evento válido; los campos extra (p. ej. `userId`) se ignoran. */
export function parseProductViewPayload(raw: string): ProductViewPayload | null {
  if (!raw || raw.length > PRODUCT_VIEW_MAX_BODY_BYTES) return null

  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return null
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return null

  const { sessionId, productId, source } = body as Record<string, unknown>
  if (typeof sessionId !== "string" || !UUID_PATTERN.test(sessionId)) return null
  if (typeof productId !== "number" || !Number.isSafeInteger(productId) || productId <= 0) return null
  if (!isProductViewSource(source)) return null

  return { sessionId: sessionId.toLowerCase(), productId, source }
}

const BOT_PATTERN = /bot|crawl|spider|slurp|headless|lighthouse|facebookexternalhit|curl|wget|python-requests/i
const TABLET_PATTERN = /ipad|tablet|playbook|silk|kindle|android(?!.*mobile)/i
const MOBILE_PATTERN = /mobi|iphone|ipod|android.*mobile|windows phone|blackberry|opera mini/i

/** Navegación automatizada: no es una vista de una persona. */
export function isAutomatedUserAgent(userAgent: string | null) {
  return !userAgent || BOT_PATTERN.test(userAgent)
}

export function getDeviceType(userAgent: string | null): DeviceType {
  if (!userAgent) return "desktop"
  if (TABLET_PATTERN.test(userAgent)) return "tablet"
  if (MOBILE_PATTERN.test(userAgent)) return "mobile"
  return "desktop"
}

const CLIENT_KEY_DOMAIN = "beyonix:analytics:client-key:v1"

/**
 * Identificador de origen sólo para límites de abuso: HMAC del IP con un
 * secreto server-side y la fecha UTC, truncado. No es reversible sin el
 * secreto y cambia cada día, así que no permite seguir a un visitante en el
 * tiempo. Nunca se guarda el IP.
 */
export function getAnalyticsClientKey(
  ip: string | null,
  now: Date = new Date(),
  secret: string | undefined = process.env.SUPABASE_SERVICE_ROLE_KEY,
): string | null {
  const normalizedIp = ip?.trim()
  const normalizedSecret = secret?.trim()
  if (!normalizedIp || !normalizedSecret) return null

  return createHmac("sha256", normalizedSecret)
    .update(`${CLIENT_KEY_DOMAIN}:${now.toISOString().slice(0, 10)}:${normalizedIp}`)
    .digest("hex")
    .slice(0, 32)
}
