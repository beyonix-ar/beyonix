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

const CLIENT_KEY_DOMAIN = "beyonix:analytics:origin:v2"

/** Variable dedicada: nunca se reutiliza otra credencial (en particular, nunca la service_role). */
export const ANALYTICS_ORIGIN_HASH_SECRET_ENV = "ANALYTICS_ORIGIN_HASH_SECRET"
const MIN_SECRET_BYTES = 32

/** Secreto del hash de origen, o `null` si falta o es demasiado corto. */
export function getAnalyticsOriginSecret(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const secret = env[ANALYTICS_ORIGIN_HASH_SECRET_ENV]?.trim()
  return secret && Buffer.byteLength(secret, "utf8") >= MIN_SECRET_BYTES ? secret : null
}

/**
 * Identificador de origen sólo para el límite de abuso por origen: HMAC del
 * IP con un secreto server-side dedicado, truncado. Es estable (no depende de
 * la fecha), así la ventana móvil de 60 minutos de `record_product_view` no
 * se parte a medianoche; no es reversible sin el secreto, que nunca se guarda
 * en la base ni llega al navegador. Nunca se guarda el IP.
 *
 * Sin secreto configurado devuelve `null`: se desactiva SÓLO el límite por
 * origen (el de sesión y la deduplicación siguen) y las vistas se registran
 * igual.
 */
export function getAnalyticsClientKey(
  ip: string | null,
  secret: string | null = getAnalyticsOriginSecret(),
): string | null {
  const normalizedIp = ip?.trim()
  if (!normalizedIp || !secret) return null

  return createHmac("sha256", secret)
    .update(`${CLIENT_KEY_DOMAIN}:${normalizedIp}`)
    .digest("hex")
    .slice(0, 32)
}
