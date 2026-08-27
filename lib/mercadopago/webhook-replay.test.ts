import assert from "node:assert/strict"
import test from "node:test"

import {
  claimMercadoPagoWebhookDelivery,
  releaseMercadoPagoWebhookDelivery,
  resetMercadoPagoWebhookReplayCacheForTests,
} from "./webhook-replay.ts"

test("el mismo request-id y paymentId no se procesa dos veces", () => {
  resetMercadoPagoWebhookReplayCacheForTests()

  const first = claimMercadoPagoWebhookDelivery("payment-1", "request-1", 1000)
  const replay = claimMercadoPagoWebhookDelivery("payment-1", "request-1", 1001)

  assert.equal(typeof first, "string")
  assert.equal(replay, null)
})

test("operaciones distintas no comparten la reserva anti-replay", () => {
  resetMercadoPagoWebhookReplayCacheForTests()

  const firstPayment = claimMercadoPagoWebhookDelivery(
    "payment-1",
    "request-1",
    1000,
  )
  const anotherPayment = claimMercadoPagoWebhookDelivery(
    "payment-2",
    "request-1",
    1000,
  )
  const anotherRequest = claimMercadoPagoWebhookDelivery(
    "payment-1",
    "request-2",
    1000,
  )

  assert.notEqual(firstPayment, null)
  assert.notEqual(anotherPayment, null)
  assert.notEqual(anotherRequest, null)
})

test("si el procesamiento falla, la entrega puede reintentarse", () => {
  resetMercadoPagoWebhookReplayCacheForTests()

  const claim = claimMercadoPagoWebhookDelivery("payment-1", "request-1", 1000)
  assert.notEqual(claim, null)

  releaseMercadoPagoWebhookDelivery(claim!)

  assert.notEqual(
    claimMercadoPagoWebhookDelivery("payment-1", "request-1", 1001),
    null,
  )
})
