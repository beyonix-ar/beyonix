import assert from "node:assert/strict"
import test from "node:test"

import {
  ANALYTICS_ORIGIN_HASH_SECRET_ENV,
  getAnalyticsClientKey,
  getAnalyticsOriginSecret,
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

test("clave de origen: HMAC estable con el secreto dedicado; nunca contiene el IP", () => {
  const secret = "s".repeat(40)
  const key = getAnalyticsClientKey("203.0.113.9", secret)!
  assert.match(key, /^[0-9a-f]{32}$/)
  assert.ok(!key.includes("203"))
  assert.equal(getAnalyticsClientKey(" 203.0.113.9 ", secret), key)
  assert.notEqual(getAnalyticsClientKey("203.0.113.9", "t".repeat(40)), key, "depende del secreto")
  assert.notEqual(getAnalyticsClientKey("203.0.113.10", secret), key)
  assert.equal(getAnalyticsClientKey(null, secret), null)
  assert.equal(getAnalyticsClientKey("203.0.113.9", null), null)
})

test("clave de origen: no cambia a medianoche (la ventana móvil de 60 min no se parte)", (t) => {
  const secret = "s".repeat(40)
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-26T23:59:59.000Z") })
  const beforeMidnight = getAnalyticsClientKey("203.0.113.9", secret)
  t.mock.timers.setTime(Date.parse("2026-10-27T00:00:01.000Z"))
  assert.equal(getAnalyticsClientKey("203.0.113.9", secret), beforeMidnight)
})

test("secreto de origen: sólo ANALYTICS_ORIGIN_HASH_SECRET; jamás la service_role como respaldo", () => {
  const serviceRole = "service-role-key-".repeat(4)
  const dedicated = "dedicated-origin-secret-".repeat(2)
  assert.equal(getAnalyticsOriginSecret({ SUPABASE_SERVICE_ROLE_KEY: serviceRole }), null, "sin la variable dedicada: desactivado")
  assert.equal(getAnalyticsOriginSecret({ SUPABASE_SERVICE_ROLE_KEY: serviceRole, ANALYTICS_ORIGIN_HASH_SECRET: dedicated }), dedicated)
  assert.equal(getAnalyticsOriginSecret({ ANALYTICS_ORIGIN_HASH_SECRET: "corto" }), null, "menos de 32 bytes no alcanza")
  assert.equal(getAnalyticsOriginSecret({ ANALYTICS_ORIGIN_HASH_SECRET: "   " }), null)
  assert.equal(ANALYTICS_ORIGIN_HASH_SECRET_ENV, "ANALYTICS_ORIGIN_HASH_SECRET")

  const previous = { ...process.env }
  try {
    process.env.SUPABASE_SERVICE_ROLE_KEY = serviceRole
    delete process.env.ANALYTICS_ORIGIN_HASH_SECRET
    assert.equal(getAnalyticsClientKey("203.0.113.9"), null, "por defecto tampoco cae en la service_role")
    process.env.ANALYTICS_ORIGIN_HASH_SECRET = dedicated
    assert.equal(getAnalyticsClientKey("203.0.113.9"), getAnalyticsClientKey("203.0.113.9", dedicated))
    assert.notEqual(getAnalyticsClientKey("203.0.113.9"), getAnalyticsClientKey("203.0.113.9", serviceRole))
  } finally {
    for (const key of ["SUPABASE_SERVICE_ROLE_KEY", "ANALYTICS_ORIGIN_HASH_SECRET"]) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]
    }
  }
})
