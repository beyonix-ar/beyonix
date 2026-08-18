import { createHmac, timingSafeEqual } from "node:crypto"

interface GuestOrderTokenClaims {
  version: 1
  orderId: number
  expiresAt: number
}

interface GuestOrderTokenCryptoOptions {
  now?: number
  secret?: string
}

const GUEST_ORDER_TOKEN_VERSION = 1
const GUEST_ORDER_TOKEN_TTL_MS = 48 * 60 * 60 * 1000
const GUEST_ORDER_TOKEN_DOMAIN = "beyonix:guest-order-access:v1\0"
const MAX_GUEST_ORDER_TOKEN_LENGTH = 4_096

function getGuestOrderTokenSecret(explicitSecret?: string) {
  const secret =
    explicitSecret?.trim() ||
    process.env.GUEST_ORDER_TOKEN_SECRET?.trim() ||
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()

  if (!secret || Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error(
      "La firma server-side de acceso a pedidos guest no está configurada.",
    )
  }

  return secret
}

function signPayload(payload: string, secret: string) {
  return createHmac("sha256", secret)
    .update(GUEST_ORDER_TOKEN_DOMAIN)
    .update(payload)
    .digest("base64url")
}

/**
 * Emite un token opaco, autocontenido e impredecible que prueba posesión de un
 * pedido guest (usuario_id null) recién creado, sin persistir ningún secreto
 * nuevo en la base. Se firma con HMAC-SHA256 sobre un payload versionado con
 * expiración embebida, siguiendo el mismo esquema que
 * lib/cart/checkout-shipping.ts usa para las cotizaciones de envío firmadas.
 */
export function createGuestOrderAccessToken(
  orderId: number,
  options: GuestOrderTokenCryptoOptions & { ttlMs?: number } = {},
) {
  const now = options.now ?? Date.now()
  const ttlMs = options.ttlMs ?? GUEST_ORDER_TOKEN_TTL_MS

  const claims: GuestOrderTokenClaims = {
    version: GUEST_ORDER_TOKEN_VERSION,
    orderId,
    expiresAt: now + ttlMs,
  }

  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString(
    "base64url",
  )
  const signature = signPayload(payload, getGuestOrderTokenSecret(options.secret))

  return `${payload}.${signature}`
}

/**
 * Verifica que `token` sea una prueba de posesión válida y vigente para
 * `orderId`. Nunca lanza: cualquier token ausente, malformado, vencido, o
 * emitido para otro pedido, devuelve false.
 */
export function verifyGuestOrderAccessToken(
  token: string | null | undefined,
  orderId: number,
  options: GuestOrderTokenCryptoOptions = {},
): boolean {
  const trimmed = token?.trim() ?? ""
  if (!trimmed || trimmed.length > MAX_GUEST_ORDER_TOKEN_LENGTH) return false

  const parts = trimmed.split(".")
  if (parts.length !== 2) return false
  const [payload, receivedSignature] = parts
  if (!payload || !receivedSignature) return false

  let expectedSignature: string
  try {
    expectedSignature = signPayload(payload, getGuestOrderTokenSecret(options.secret))
  } catch {
    return false
  }

  const expectedBuffer = Buffer.from(expectedSignature)
  const receivedBuffer = Buffer.from(receivedSignature)
  if (
    expectedBuffer.length !== receivedBuffer.length ||
    !timingSafeEqual(expectedBuffer, receivedBuffer)
  ) {
    return false
  }

  let claims: GuestOrderTokenClaims
  try {
    claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as GuestOrderTokenClaims
  } catch {
    return false
  }

  const now = options.now ?? Date.now()

  return (
    claims.version === GUEST_ORDER_TOKEN_VERSION &&
    claims.orderId === orderId &&
    Number.isSafeInteger(claims.expiresAt) &&
    claims.expiresAt >= now
  )
}
