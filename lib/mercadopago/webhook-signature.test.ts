import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import test from "node:test"

import { isValidWebhookSignature } from "./webhook-signature.ts"

const SECRET = "test-webhook-secret"

function requestWithHeaders(
  method: string,
  headers: Record<string, string>,
) {
  const map = new Map(Object.entries(headers))
  return {
    method,
    headers: { get: (key: string) => map.get(key) ?? null },
  }
}

function signedRequest(paymentId: string, requestId: string, ts: string, secret = SECRET) {
  const manifest = `id:${paymentId.toLowerCase()};request-id:${requestId};ts:${ts};`
  const hash = createHmac("sha256", secret).update(manifest).digest("hex")
  return requestWithHeaders("POST", {
    "x-signature": `ts=${ts},v1=${hash}`,
    "x-request-id": requestId,
  })
}

test("una firma válida generada con el secreto correcto se acepta", () => {
  const request = signedRequest("123456789", "req-1", "1700000000")
  assert.equal(isValidWebhookSignature(request, "123456789", SECRET), true)
})

test("un webhook falso firmado con un secreto distinto se rechaza", () => {
  const request = signedRequest("123456789", "req-1", "1700000000", "otro-secreto")
  assert.equal(isValidWebhookSignature(request, "123456789", SECRET), false)
})

test("reusar una firma válida para otro payment id se rechaza (anti-replay cruzado)", () => {
  const request = signedRequest("123456789", "req-1", "1700000000")
  assert.equal(isValidWebhookSignature(request, "999999999", SECRET), false)
})

test("un x-signature sin el campo v1 se rechaza", () => {
  const request = requestWithHeaders("POST", {
    "x-signature": "ts=1700000000",
    "x-request-id": "req-1",
  })
  assert.equal(isValidWebhookSignature(request, "123456789", SECRET), false)
})

test("falta el header x-request-id se rechaza", () => {
  const request = requestWithHeaders("POST", {
    "x-signature": "ts=1700000000,v1=abc",
  })
  assert.equal(isValidWebhookSignature(request, "123456789", SECRET), false)
})

test("falta el header x-signature se rechaza", () => {
  const request = requestWithHeaders("POST", { "x-request-id": "req-1" })
  assert.equal(isValidWebhookSignature(request, "123456789", SECRET), false)
})

test("sin secreto configurado, en producción se rechaza en vez de aceptar en silencio", () => {
  const request = signedRequest("123456789", "req-1", "1700000000")
  assert.equal(
    isValidWebhookSignature(request, "123456789", undefined, "production"),
    false,
  )
})

test("sin secreto configurado fuera de producción no bloquea el flujo local", () => {
  const request = requestWithHeaders("POST", {})
  assert.equal(
    isValidWebhookSignature(request, "123456789", undefined, "development"),
    true,
  )
})

test("una petición GET (IPN legado) no depende de la firma", () => {
  const request = requestWithHeaders("GET", {})
  assert.equal(isValidWebhookSignature(request, "123456789", SECRET), true)
})
