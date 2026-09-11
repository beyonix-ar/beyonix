import assert from "node:assert/strict"
import test from "node:test"

import {
  createMercadoPagoRefund,
  getMercadoPagoRefundStatus,
} from "./refunds.ts"

const originalToken = process.env.MERCADOPAGO_ACCESS_TOKEN
test.before(() => {
  process.env.MERCADOPAGO_ACCESS_TOKEN = "TEST-secret-token-never-logged"
})
test.after(() => {
  if (originalToken === undefined) delete process.env.MERCADOPAGO_ACCESS_TOKEN
  else process.env.MERCADOPAGO_ACCESS_TOKEN = originalToken
})

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

test("refund confirmado: usa X-Idempotency-Key estable (la que se le pasa, nunca generada acá) y nunca incluye el token en el body", async () => {
  const calls: Array<{ url: string; headers: Headers; body: unknown }> = []
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: init?.body,
    })
    return jsonResponse(201, { id: 555, payment_id: 9001, amount: 70000, status: "approved" })
  }) as typeof fetch

  const result = await createMercadoPagoRefund("9001", "mercadopago-order-refund:abc", fakeFetch)

  assert.equal(result.kind, "confirmed")
  if (result.kind === "confirmed") {
    assert.equal(result.refund.id, 555)
    assert.equal(result.refund.payment_id, 9001)
  }
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /\/v1\/payments\/9001\/refunds$/)
  assert.equal(calls[0].headers.get("X-Idempotency-Key"), "mercadopago-order-refund:abc")
  assert.ok(calls[0].headers.get("Authorization")?.startsWith("Bearer "))
  assert.doesNotMatch(String(calls[0].body ?? ""), /TEST-secret-token/)
})

test("dos llamadas con la MISMA idempotencyKey nunca generan una key nueva por su cuenta", async () => {
  const keys: string[] = []
  const fakeFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    keys.push(new Headers(init?.headers).get("X-Idempotency-Key") ?? "")
    return jsonResponse(201, { id: 1, payment_id: 9001, amount: 70000 })
  }) as typeof fetch

  await createMercadoPagoRefund("9001", "same-key-123", fakeFetch)
  await createMercadoPagoRefund("9001", "same-key-123", fakeFetch)

  assert.deepEqual(keys, ["same-key-123", "same-key-123"])
})

test("timeout de red se clasifica como 'unknown', nunca como 'rejected'/fallo definitivo", async () => {
  const fakeFetch = (async () => {
    throw new DOMException("The operation timed out.", "TimeoutError")
  }) as typeof fetch

  const result = await createMercadoPagoRefund("9001", "key-1", fakeFetch)
  assert.equal(result.kind, "unknown")
})

test("error de red genérico (no timeout) también es 'unknown', nunca 'rejected'", async () => {
  const fakeFetch = (async () => {
    throw new Error("fetch failed: ECONNRESET")
  }) as typeof fetch

  const result = await createMercadoPagoRefund("9001", "key-1", fakeFetch)
  assert.equal(result.kind, "unknown")
})

test("5xx de Mercado Pago se trata como 'unknown' (el propio MP no puede confirmar su resultado), no como rechazo definitivo", async () => {
  const fakeFetch = (async () => jsonResponse(503, { message: "Service unavailable" })) as typeof fetch

  const result = await createMercadoPagoRefund("9001", "key-1", fakeFetch)
  assert.equal(result.kind, "unknown")
})

test("respuesta 2xx sin JSON válido (o sin id de refund) es 'unknown', nunca 'confirmed'", async () => {
  const fakeFetchNoJson = (async () =>
    new Response("not json", { status: 201 })) as typeof fetch
  const resultNoJson = await createMercadoPagoRefund("9001", "key-1", fakeFetchNoJson)
  assert.equal(resultNoJson.kind, "unknown")

  const fakeFetchNoId = (async () => jsonResponse(201, { status: "approved" })) as typeof fetch
  const resultNoId = await createMercadoPagoRefund("9001", "key-1", fakeFetchNoId)
  assert.equal(resultNoId.kind, "unknown")
})

test("4xx con cuerpo JSON parseable es un rechazo DEFINITIVO ('rejected'), no ambiguo", async () => {
  const fakeFetch = (async () =>
    jsonResponse(400, {
      message: "Payment already refunded",
      cause: [{ code: "4020", description: "Payment already refunded" }],
    })) as typeof fetch

  const result = await createMercadoPagoRefund("9001", "key-1", fakeFetch)
  assert.equal(result.kind, "rejected")
  if (result.kind === "rejected") {
    assert.equal(result.status, 400)
    assert.equal(result.code, "4020")
    assert.match(result.message, /already refunded/)
  }
})

test("payment_id inválido nunca llega a hacer fetch", async () => {
  let called = false
  const fakeFetch = (async () => {
    called = true
    return jsonResponse(201, {})
  }) as typeof fetch

  const result = await createMercadoPagoRefund("no-es-un-id", "key-1", fakeFetch)
  assert.equal(result.kind, "unknown")
  assert.equal(called, false)
})

test("getMercadoPagoRefundStatus: 404 es 'not_found' (Mercado Pago nunca recibió el refund)", async () => {
  const fakeFetch = (async () => new Response(null, { status: 404 })) as typeof fetch
  const result = await getMercadoPagoRefundStatus("9001", "555", fakeFetch)
  assert.equal(result.kind, "not_found")
})

test("getMercadoPagoRefundStatus: refund encontrado", async () => {
  const fakeFetch = (async () =>
    jsonResponse(200, { id: 555, payment_id: 9001, amount: 70000, status: "approved" })) as typeof fetch
  const result = await getMercadoPagoRefundStatus("9001", "555", fakeFetch)
  assert.equal(result.kind, "found")
  if (result.kind === "found") assert.equal(result.refund.id, 555)
})

test("getMercadoPagoRefundStatus: timeout/5xx es 'unknown', nunca 'not_found'", async () => {
  const fakeFetch = (async () => jsonResponse(500, {})) as typeof fetch
  const result = await getMercadoPagoRefundStatus("9001", "555", fakeFetch)
  assert.equal(result.kind, "unknown")
})
