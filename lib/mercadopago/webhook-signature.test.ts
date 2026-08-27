import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  MERCADOPAGO_WEBHOOK_MAX_AGE_MS,
  MERCADOPAGO_WEBHOOK_MAX_FUTURE_SKEW_MS,
  isValidWebhookSignature,
  validateMercadoPagoWebhookSignature,
} from "./webhook-signature.ts"

const SECRET = "test-webhook-secret"
const NOW_MS = 1_742_505_638_683

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

function signedRequest(
  paymentId: string,
  requestId: string,
  ts = String(NOW_MS),
  secret = SECRET,
) {
  const manifest = `id:${paymentId.toLowerCase()};request-id:${requestId};ts:${ts};`
  const hash = createHmac("sha256", secret).update(manifest).digest("hex")
  return requestWithHeaders("POST", {
    "x-signature": `ts=${ts},v1=${hash}`,
    "x-request-id": requestId,
  })
}

test("POST con firma y secreto correctos se permite", () => {
  const request = signedRequest("123456789", "req-1")
  const result = validateMercadoPagoWebhookSignature(
    request,
    "123456789",
    SECRET,
    NOW_MS,
  )

  assert.deepEqual(result, {
    valid: true,
    requestId: "req-1",
    timestamp: String(NOW_MS),
  })
})

test("una firma creada con otro secreto se rechaza", () => {
  const request = signedRequest(
    "123456789",
    "req-1",
    String(NOW_MS),
    "otro-secreto",
  )
  assert.equal(
    isValidWebhookSignature(request, "123456789", SECRET, NOW_MS),
    false,
  )
})

test("reusar una firma para otro payment id se rechaza", () => {
  const request = signedRequest("123456789", "req-1")
  assert.equal(
    isValidWebhookSignature(request, "999999999", SECRET, NOW_MS),
    false,
  )
})

test("una firma claramente vencida se rechaza", () => {
  const timestamp = NOW_MS - MERCADOPAGO_WEBHOOK_MAX_AGE_MS - 1
  const request = signedRequest("123456789", "req-old", String(timestamp))

  assert.equal(
    isValidWebhookSignature(request, "123456789", SECRET, NOW_MS),
    false,
  )
})

test("una firma demasiado adelantada se rechaza", () => {
  const timestamp = NOW_MS + MERCADOPAGO_WEBHOOK_MAX_FUTURE_SKEW_MS + 1
  const request = signedRequest("123456789", "req-future", String(timestamp))

  assert.equal(
    isValidWebhookSignature(request, "123456789", SECRET, NOW_MS),
    false,
  )
})

test("sin MERCADOPAGO_WEBHOOK_SECRET el webhook falla cerrado", () => {
  const request = signedRequest("123456789", "req-1")
  assert.equal(
    isValidWebhookSignature(request, "123456789", undefined, NOW_MS),
    false,
  )
})

test("MERCADOPAGO_WEBHOOK_SECRET vacío o en blanco falla cerrado", () => {
  const request = signedRequest("123456789", "req-1")
  assert.equal(
    isValidWebhookSignature(request, "123456789", "", NOW_MS),
    false,
  )
  assert.equal(
    isValidWebhookSignature(request, "123456789", "   ", NOW_MS),
    false,
  )
})

test("GET legacy se rechaza aunque incluya una firma válida", () => {
  const post = signedRequest("123456789", "req-1")
  const request = {
    ...post,
    method: "GET",
  }

  assert.equal(
    isValidWebhookSignature(request, "123456789", SECRET, NOW_MS),
    false,
  )
})

test("headers oficiales incompletos se rechazan", () => {
  assert.equal(
    isValidWebhookSignature(
      requestWithHeaders("POST", {
        "x-signature": `ts=${NOW_MS}`,
        "x-request-id": "req-1",
      }),
      "123456789",
      SECRET,
      NOW_MS,
    ),
    false,
  )
  assert.equal(
    isValidWebhookSignature(
      requestWithHeaders("POST", {
        "x-signature": `ts=${NOW_MS},v1=${"a".repeat(64)}`,
      }),
      "123456789",
      SECRET,
      NOW_MS,
    ),
    false,
  )
})

test("la ruta deshabilita GET y autentica antes de consultar el pago", () => {
  const route = readFileSync(
    new URL("../../app/api/mercadopago/webhook/route.ts", import.meta.url),
    "utf8",
  )
  const validateAt = route.indexOf("validateMercadoPagoWebhookSignature(")
  const fetchPaymentAt = route.indexOf("getMercadoPagoPayment(paymentId)")

  assert.match(route, /export async function GET[\s\S]*status: 405/)
  assert.doesNotMatch(
    route.match(/export async function GET[\s\S]*$/)?.[0] ?? "",
    /handleWebhook\(request\)/,
  )
  assert.match(route, /if \(!webhookSecret\?\.trim\(\)\)[\s\S]*status: 503/)
  assert.match(
    route,
    /if \(!replayClaim\)[\s\S]*duplicated: true/,
  )
  assert.ok(validateAt >= 0 && fetchPaymentAt > validateAt)
})
