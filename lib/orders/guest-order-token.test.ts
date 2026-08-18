import assert from "node:assert/strict"
import test from "node:test"

import {
  createGuestOrderAccessToken,
  verifyGuestOrderAccessToken,
} from "./guest-order-token.ts"

const TEST_SECRET = "beyonix-guest-order-token-test-secret-2026"
const NOW = Date.UTC(2026, 7, 15, 12)

test("un guest legítimo con el token correcto para su pedido es autorizado", () => {
  const token = createGuestOrderAccessToken(501, { secret: TEST_SECRET, now: NOW })

  assert.equal(
    verifyGuestOrderAccessToken(token, 501, { secret: TEST_SECRET, now: NOW }),
    true,
  )
})

test("un guest sin token es rechazado", () => {
  assert.equal(
    verifyGuestOrderAccessToken(null, 501, { secret: TEST_SECRET, now: NOW }),
    false,
  )
  assert.equal(
    verifyGuestOrderAccessToken("", 501, { secret: TEST_SECRET, now: NOW }),
    false,
  )
  assert.equal(
    verifyGuestOrderAccessToken(undefined, 501, { secret: TEST_SECRET, now: NOW }),
    false,
  )
})

test("un token válido para OTRO pedido no autoriza este pedido (no se puede reutilizar entre pedidos)", () => {
  const tokenForOtherOrder = createGuestOrderAccessToken(999, {
    secret: TEST_SECRET,
    now: NOW,
  })

  assert.equal(
    verifyGuestOrderAccessToken(tokenForOtherOrder, 501, {
      secret: TEST_SECRET,
      now: NOW,
    }),
    false,
  )
})

test("un orderId ajeno (adivinado) nunca es autorizado sin su propio token", () => {
  // Simula el escenario del IDOR: un atacante conoce el ID de un pedido ajeno
  // pero nunca recibió un token para ese pedido.
  assert.equal(
    verifyGuestOrderAccessToken(null, 123456, { secret: TEST_SECRET, now: NOW }),
    false,
  )
})

test("un token vencido (fuera de la ventana de 48hs) es rechazado", () => {
  const token = createGuestOrderAccessToken(501, {
    secret: TEST_SECRET,
    now: NOW,
    ttlMs: 1000,
  })

  assert.equal(
    verifyGuestOrderAccessToken(token, 501, {
      secret: TEST_SECRET,
      now: NOW + 1001,
    }),
    false,
  )
})

test("un token con firma manipulada es rechazado", () => {
  const token = createGuestOrderAccessToken(501, { secret: TEST_SECRET, now: NOW })
  const [payload] = token.split(".")
  const tampered = `${payload}.${"a".repeat(43)}`

  assert.equal(
    verifyGuestOrderAccessToken(tampered, 501, { secret: TEST_SECRET, now: NOW }),
    false,
  )
})

test("un token con payload manipulado (orderId alterado en el payload) es rechazado", () => {
  const token = createGuestOrderAccessToken(501, { secret: TEST_SECRET, now: NOW })
  const [payload, signature] = token.split(".")
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
    orderId: number
  }
  claims.orderId = 999
  const tamperedPayload = Buffer.from(JSON.stringify(claims), "utf8").toString(
    "base64url",
  )
  const tamperedToken = `${tamperedPayload}.${signature}`

  assert.equal(
    verifyGuestOrderAccessToken(tamperedToken, 999, {
      secret: TEST_SECRET,
      now: NOW,
    }),
    false,
  )
})

test("un token firmado con un secreto distinto es rechazado", () => {
  const token = createGuestOrderAccessToken(501, {
    secret: "otro-secreto-completamente-distinto-32b",
    now: NOW,
  })

  assert.equal(
    verifyGuestOrderAccessToken(token, 501, { secret: TEST_SECRET, now: NOW }),
    false,
  )
})

test("tokens malformados (sin punto separador, vacíos, con partes extra) son rechazados", () => {
  assert.equal(
    verifyGuestOrderAccessToken("no-es-un-token-valido", 501, {
      secret: TEST_SECRET,
      now: NOW,
    }),
    false,
  )
  assert.equal(
    verifyGuestOrderAccessToken("a.b.c", 501, { secret: TEST_SECRET, now: NOW }),
    false,
  )
})
