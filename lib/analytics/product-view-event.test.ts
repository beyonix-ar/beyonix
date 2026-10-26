import assert from "node:assert/strict"
import test from "node:test"

import {
  getAnalyticsClientKey,
  getDeviceType,
  isAutomatedUserAgent,
  parseProductViewPayload,
} from "./product-view-event.ts"

const SESSION = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b"

test("payload: sólo sesión UUID, producto entero positivo y origen conocido; los extras se ignoran", () => {
  assert.deepEqual(
    parseProductViewPayload(JSON.stringify({ sessionId: SESSION.toUpperCase(), productId: 12, source: "product_page", userId: "otro-usuario", email: "x@y.z" })),
    { sessionId: SESSION, productId: 12, source: "product_page" },
    "user_id/email del cliente nunca pasan",
  )
  for (const body of [
    "",
    "{",
    "[]",
    JSON.stringify({ sessionId: "abc", productId: 1, source: "quick_view" }),
    JSON.stringify({ sessionId: SESSION, productId: "1", source: "quick_view" }),
    JSON.stringify({ sessionId: SESSION, productId: 0, source: "quick_view" }),
    JSON.stringify({ sessionId: SESSION, productId: 1.5, source: "quick_view" }),
    JSON.stringify({ sessionId: SESSION, productId: 1, source: "home" }),
    JSON.stringify({ sessionId: SESSION, productId: 1, source: "quick_view", padding: "x".repeat(2_000) }),
  ]) {
    assert.equal(parseProductViewPayload(body), null, body.slice(0, 60))
  }
})

test("dispositivo y robots desde el User-Agent", () => {
  assert.equal(getDeviceType("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148 Safari"), "mobile")
  assert.equal(getDeviceType("Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120 Mobile Safari/537.36"), "mobile")
  assert.equal(getDeviceType("Mozilla/5.0 (Linux; Android 13; SM-X200) Chrome/120 Safari/537.36"), "tablet")
  assert.equal(getDeviceType("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)"), "tablet")
  assert.equal(getDeviceType("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36"), "desktop")
  assert.equal(getDeviceType(null), "desktop")
  assert.equal(isAutomatedUserAgent("Mozilla/5.0 (compatible; Googlebot/2.1)"), true)
  assert.equal(isAutomatedUserAgent("Mozilla/5.0 HeadlessChrome/120"), true)
  assert.equal(isAutomatedUserAgent(null), true)
  assert.equal(isAutomatedUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36"), false)
})

test("clave de origen: HMAC truncado, sin el IP, distinto por día y por secreto", () => {
  const secret = "s".repeat(40)
  const day = new Date("2026-10-26T12:00:00Z")
  const key = getAnalyticsClientKey("203.0.113.9", day, secret)!
  assert.match(key, /^[0-9a-f]{32}$/)
  assert.ok(!key.includes("203"))
  assert.equal(getAnalyticsClientKey(" 203.0.113.9 ", day, secret), key)
  assert.notEqual(getAnalyticsClientKey("203.0.113.9", new Date("2026-10-27T12:00:00Z"), secret), key, "rota cada día")
  assert.notEqual(getAnalyticsClientKey("203.0.113.9", day, "t".repeat(40)), key)
  assert.notEqual(getAnalyticsClientKey("203.0.113.10", day, secret), key)
  assert.equal(getAnalyticsClientKey(null, day, secret), null)
  assert.equal(getAnalyticsClientKey("203.0.113.9", day, ""), null)
})
