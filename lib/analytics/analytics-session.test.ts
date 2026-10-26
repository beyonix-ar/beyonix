import assert from "node:assert/strict"
import test from "node:test"

import { ANALYTICS_SESSION_STORAGE_KEY, claimProductView, createAnalyticsSessionId } from "./analytics-session.ts"

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    values,
  }
}

const MINUTE = 60_000
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

test("sesión anónima: UUID v4 aleatorio", () => {
  const a = createAnalyticsSessionId()!
  const b = createAnalyticsSessionId()!
  assert.match(a, UUID_V4)
  assert.notEqual(a, b)
})

test("misma sesión: un producto se envía una vez cada 30 min; otro producto sí", () => {
  const storage = memoryStorage()
  const t0 = Date.UTC(2026, 9, 26, 12)
  const first = claimProductView(1, t0, storage)
  assert.ok(first)
  assert.equal(claimProductView(1, t0 + 1_000, storage), null, "refresh inmediato")
  assert.equal(claimProductView(1, t0 + 29 * MINUTE, storage), null)
  const other = claimProductView(2, t0 + 29 * MINUTE, storage)
  assert.deepEqual(other, { sessionId: first.sessionId }, "otro producto, misma sesión")
  const again = claimProductView(1, t0 + 31 * MINUTE, storage)
  assert.deepEqual(again, { sessionId: first.sessionId }, "pasada la ventana, misma sesión activa")
})

test("sesión nueva tras 30 min de inactividad u otro navegador; nunca datos personales", () => {
  const storage = memoryStorage()
  const t0 = Date.UTC(2026, 9, 26, 12)
  const first = claimProductView(1, t0, storage)!
  const afterIdle = claimProductView(1, t0 + 31 * MINUTE, storage)!
  assert.notEqual(afterIdle.sessionId, first.sessionId)

  const otherBrowser = claimProductView(1, t0, memoryStorage())!
  assert.notEqual(otherBrowser.sessionId, first.sessionId, "otra sesión cuenta otra vista")

  const stored = JSON.parse(storage.values.get(ANALYTICS_SESSION_STORAGE_KEY)!) as Record<string, unknown>
  assert.deepEqual(Object.keys(stored).sort(), ["id", "lastActivityAt", "views"])
})

test("storage dañado o bloqueado: no rompe y sigue deduplicando en memoria", () => {
  const corrupt = memoryStorage()
  corrupt.values.set(ANALYTICS_SESSION_STORAGE_KEY, "{no-json")
  assert.ok(claimProductView(1, Date.now(), corrupt))

  const blocked = {
    getItem: () => { throw new Error("SecurityError") },
    setItem: () => { throw new Error("QuotaExceededError") },
  }
  const now = Date.now()
  assert.ok(claimProductView(9, now, null))
  assert.equal(claimProductView(9, now + 1_000, null), null, "sin storage, la sesión vive en memoria")
  assert.doesNotThrow(() => claimProductView(10, now, blocked))
})
