import "server-only"

import { createHmac, timingSafeEqual } from "node:crypto"

export interface WebhookSignatureRequestLike {
  method: string
  headers: Pick<Headers, "get">
}

/**
 * Implementa el esquema oficial de Mercado Pago (`x-signature: ts=...,v1=...`
 * sobre el manifiesto `id:<paymentId>;request-id:<requestId>;ts:<ts>;`).
 * GET siempre se acepta porque corresponde al mecanismo IPN legado de MP, que
 * nunca envía firma: la fuente de verdad real es igualmente
 * `getMercadoPagoPayment` (re-consulta server-side contra la API de MP), así
 * que aceptar un GET sin firma no permite fabricar un pago aprobado falso.
 */
export function isValidWebhookSignature(
  request: WebhookSignatureRequestLike,
  paymentId: string,
  secret = process.env.MERCADOPAGO_WEBHOOK_SECRET,
  nodeEnv = process.env.NODE_ENV,
) {
  if (request.method === "GET") return true
  if (!secret) return nodeEnv !== "production"

  const signature = request.headers.get("x-signature")
  const requestId = request.headers.get("x-request-id")
  if (!signature || !requestId) return false

  const parts = new Map(
    signature.split(",").map((part) => {
      const [key, ...value] = part.trim().split("=")
      return [key, value.join("=")]
    }),
  )
  const timestamp = parts.get("ts")
  const receivedHash = parts.get("v1")
  if (!timestamp || !receivedHash) return false

  const manifest = `id:${paymentId.toLowerCase()};request-id:${requestId};ts:${timestamp};`
  const expectedHash = createHmac("sha256", secret).update(manifest).digest("hex")
  const expectedBuffer = Buffer.from(expectedHash)
  const receivedBuffer = Buffer.from(receivedHash)

  return (
    expectedBuffer.length === receivedBuffer.length &&
    timingSafeEqual(expectedBuffer, receivedBuffer)
  )
}
