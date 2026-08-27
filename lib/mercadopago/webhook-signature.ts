import "server-only"

import { createHmac, timingSafeEqual } from "node:crypto"

export interface WebhookSignatureRequestLike {
  method: string
  headers: Pick<Headers, "get">
}

export const MERCADOPAGO_WEBHOOK_MAX_AGE_MS = 10 * 60 * 1000
export const MERCADOPAGO_WEBHOOK_MAX_FUTURE_SKEW_MS = 2 * 60 * 1000

export interface MercadoPagoWebhookSignatureValidation {
  valid: boolean
  requestId: string | null
  timestamp: string | null
}

function parseTimestampMs(timestamp: string) {
  if (!/^\d{10,16}$/.test(timestamp)) return null

  const numericTimestamp = Number(timestamp)
  if (!Number.isSafeInteger(numericTimestamp) || numericTimestamp <= 0) {
    return null
  }

  // Mercado Pago actualmente emite milisegundos. Aceptar segundos mantiene
  // compatibilidad con entregas anteriores sin alterar el valor firmado.
  return numericTimestamp < 1_000_000_000_000
    ? numericTimestamp * 1000
    : numericTimestamp
}

/**
 * Valida el esquema oficial de Mercado Pago (`x-signature: ts=...,v1=...`
 * sobre el manifiesto `id:<paymentId>;request-id:<requestId>;ts:<ts>;`).
 * Solo Webhooks POST firmados son válidos; IPN/GET legado se rechaza.
 */
export function validateMercadoPagoWebhookSignature(
  request: WebhookSignatureRequestLike,
  paymentId: string,
  secret = process.env.MERCADOPAGO_WEBHOOK_SECRET,
  nowMs = Date.now(),
): MercadoPagoWebhookSignatureValidation {
  if (request.method.toUpperCase() !== "POST" || !secret?.trim()) {
    return { valid: false, requestId: null, timestamp: null }
  }

  const signature = request.headers.get("x-signature")
  const requestId = request.headers.get("x-request-id")?.trim() ?? ""
  if (!signature || !requestId) {
    return { valid: false, requestId: requestId || null, timestamp: null }
  }

  const parts = new Map(
    signature.split(",").map((part) => {
      const [key, ...value] = part.trim().split("=")
      return [key, value.join("=")]
    }),
  )
  const timestamp = parts.get("ts") ?? ""
  const receivedHash = parts.get("v1") ?? ""
  const timestampMs = parseTimestampMs(timestamp)

  if (!timestampMs || !/^[a-f0-9]{64}$/i.test(receivedHash)) {
    return { valid: false, requestId, timestamp: timestamp || null }
  }

  const ageMs = nowMs - timestampMs
  if (
    ageMs > MERCADOPAGO_WEBHOOK_MAX_AGE_MS ||
    ageMs < -MERCADOPAGO_WEBHOOK_MAX_FUTURE_SKEW_MS
  ) {
    return { valid: false, requestId, timestamp }
  }

  const manifest = `id:${paymentId.toLowerCase()};request-id:${requestId};ts:${timestamp};`
  const expectedHash = createHmac("sha256", secret)
    .update(manifest)
    .digest("hex")
  const expectedBuffer = Buffer.from(expectedHash, "hex")
  const receivedBuffer = Buffer.from(receivedHash, "hex")

  return {
    valid:
      expectedBuffer.length === receivedBuffer.length &&
      timingSafeEqual(expectedBuffer, receivedBuffer),
    requestId,
    timestamp,
  }
}

export function isValidWebhookSignature(
  request: WebhookSignatureRequestLike,
  paymentId: string,
  secret = process.env.MERCADOPAGO_WEBHOOK_SECRET,
  nowMs = Date.now(),
) {
  return validateMercadoPagoWebhookSignature(
    request,
    paymentId,
    secret,
    nowMs,
  ).valid
}
