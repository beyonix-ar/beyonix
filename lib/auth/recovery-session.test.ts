import assert from "node:assert/strict"
import test from "node:test"

import { isRecoverySessionToken } from "./recovery-session.ts"

function fakeJwt(payload: unknown) {
  const base64url = (value: string) =>
    Buffer.from(value)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")

  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const body = base64url(JSON.stringify(payload))
  // La firma no se verifica acá (ya se validó vía admin.auth.getUser antes
  // de llamar a esta función) -- cualquier tercer segmento sirve para el test.
  return `${header}.${body}.firma-no-verificada`
}

test("un token con amr=[{method:'recovery'}] se reconoce como sesión de recuperación", () => {
  const token = fakeJwt({ amr: [{ method: "recovery", timestamp: 1 }] })
  assert.equal(isRecoverySessionToken(token), true)
})

test("un token de sesión NORMAL (password/otp, sin 'recovery') se rechaza", () => {
  const token = fakeJwt({ amr: [{ method: "password", timestamp: 1 }] })
  assert.equal(isRecoverySessionToken(token), false)
})

test("un token con múltiples métodos donde 'recovery' es uno de ellos igual pasa", () => {
  const token = fakeJwt({
    amr: [
      { method: "password", timestamp: 1 },
      { method: "recovery", timestamp: 2 },
    ],
  })
  assert.equal(isRecoverySessionToken(token), true)
})

test("un token sin claim amr se rechaza (fail closed)", () => {
  const token = fakeJwt({ sub: "user-123" })
  assert.equal(isRecoverySessionToken(token), false)
})

test("un token con amr vacío se rechaza", () => {
  const token = fakeJwt({ amr: [] })
  assert.equal(isRecoverySessionToken(token), false)
})

test("un token malformado (no 3 segmentos) se rechaza sin lanzar", () => {
  assert.equal(isRecoverySessionToken("no-es-un-jwt"), false)
  assert.equal(isRecoverySessionToken("solo.dos"), false)
  assert.equal(isRecoverySessionToken(""), false)
})

test("un payload que no es JSON válido se rechaza sin lanzar", () => {
  const corrupted = `${Buffer.from("{}").toString("base64")}.no-es-base64-json-valido.firma`
  assert.equal(isRecoverySessionToken(corrupted), false)
})

test("amr con entradas no-objeto (string, null, número) no rompe y sigue rechazando salvo que un objeto real matchee", () => {
  const token = fakeJwt({ amr: ["recovery", null, 42, { method: "recovery" }] })
  assert.equal(isRecoverySessionToken(token), true)

  const withoutMatch = fakeJwt({ amr: ["recovery", null, 42] })
  assert.equal(isRecoverySessionToken(withoutMatch), false)
})
