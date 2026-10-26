import assert from "node:assert/strict"
import test from "node:test"

import { ANALYTICS_SESSION_STORAGE_KEY, createAnalyticsSessionId, readAnalyticsSession, touchAnalyticsSession } from "./analytics-session.ts"
import { createAnalyticsStore, type AnalyticsStorageLike } from "./analytics-storage.ts"
import {
  PRODUCT_VIEW_PENDING_TIMEOUT_MS,
  PRODUCT_VIEW_RETRY_DELAY_MS,
  claimProductView,
  settleProductView,
} from "./product-view-state.ts"

const MINUTE = 60_000
const T0 = Date.UTC(2026, 9, 26, 12)
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function memoryStorage(options: { failReads?: boolean; failWrites?: boolean } = {}) {
  const values = new Map<string, string>()
  const calls = { reads: 0, writes: 0 }
  const storage: AnalyticsStorageLike = {
    getItem: (key) => {
      calls.reads += 1
      if (options.failReads) throw new Error("SecurityError")
      return values.get(key) ?? null
    },
    setItem: (key, value) => {
      calls.writes += 1
      if (options.failWrites) throw new Error("QuotaExceededError")
      values.set(key, value)
    },
  }
  return { storage, values, calls }
}

function workingStore() {
  const { storage } = memoryStorage()
  return createAnalyticsStore(() => storage)
}

test("sesión anónima: UUID v4 aleatorio", () => {
  const a = createAnalyticsSessionId()!
  assert.match(a, UUID_V4)
  assert.notEqual(a, createAnalyticsSessionId())
})

test("localStorage funcional: la sesión persiste (también para otro runtime de la misma pestaña/navegador)", () => {
  const { storage, values } = memoryStorage()
  const first = touchAnalyticsSession(T0, createAnalyticsStore(() => storage))!
  const reloaded = touchAnalyticsSession(T0 + MINUTE, createAnalyticsStore(() => storage))!
  assert.equal(reloaded.id, first.id, "un refresh reutiliza la sesión guardada")
  assert.deepEqual(Object.keys(JSON.parse(values.get(ANALYTICS_SESSION_STORAGE_KEY)!)).sort(), ["id", "lastActivityAt"], "sin datos personales")
})

test("lectura OK y escritura falla: una única sesión en memoria, sin volver a leer el storage", () => {
  const { storage, calls } = memoryStorage({ failWrites: true })
  const store = createAnalyticsStore(() => storage)
  const first = touchAnalyticsSession(T0, store)!
  assert.equal(store.persistent, false)
  const readsAfterFailure = calls.reads
  const ids = Array.from({ length: 5 }, (_, index) => touchAnalyticsSession(T0 + index * MINUTE, store)!.id)
  assert.deepEqual(new Set(ids), new Set([first.id]), "misma sesión en cada lectura")
  assert.equal(calls.reads, readsAfterFailure, "no intenta leer de nuevo un storage que no pudo guardar")
})

test("localStorage no disponible (lectura falla o no existe): una única sesión en memoria", () => {
  for (const store of [
    (() => { const { storage } = memoryStorage({ failReads: true, failWrites: true }); return createAnalyticsStore(() => storage) })(),
    createAnalyticsStore(() => null),
    createAnalyticsStore(() => { throw new Error("SecurityError") }),
  ]) {
    const first = touchAnalyticsSession(T0, store)!
    assert.match(first.id, UUID_V4)
    assert.equal(touchAnalyticsSession(T0 + 10 * MINUTE, store)!.id, first.id)
    assert.equal(store.persistent, false)
  }
})

test("actividad dentro de 30 min mantiene la sesión aunque pasen horas; 30 min sin actividad abren otra", () => {
  const store = workingStore()
  const first = touchAnalyticsSession(T0, store)!
  let now = T0
  for (let step = 0; step < 8; step += 1) {
    now += 29 * MINUTE
    assert.equal(touchAnalyticsSession(now, store)!.id, first.id, `actividad cada 29 min (${step})`)
  }
  assert.ok(now - T0 > 3 * 60 * MINUTE)
  assert.equal(readAnalyticsSession(now + 30 * MINUTE, store), null, "leer no renueva ni crea")
  const next = touchAnalyticsSession(now + 30 * MINUTE, store)!
  assert.notEqual(next.id, first.id, "30 min reales sin actividad: sesión nueva")
})

test("product_view es actividad: abrir un producto renueva la sesión", () => {
  const store = workingStore()
  const first = touchAnalyticsSession(T0, store)!
  assert.ok(claimProductView(1, T0 + 25 * MINUTE, store))
  assert.equal(readAnalyticsSession(T0 + 50 * MINUTE, store)?.id, first.id, "sin esa vista la sesión habría vencido a los 30 min")
  assert.deepEqual(claimProductView(2, T0 + 50 * MINUTE, store), { sessionId: first.id })
})

test("envío: pending no se duplica; sent no se reenvía en 30 min; otro producto sí", () => {
  const store = workingStore()
  const claim = claimProductView(1, T0, store)!
  assert.equal(claimProductView(1, T0 + 100, store), null, "doble montaje o doble click: ya está en curso")
  settleProductView(1, claim.sessionId, true, T0 + 200, store)
  assert.equal(claimProductView(1, T0 + 10 * MINUTE, store), null, "refresh: ya enviado")
  assert.ok(claimProductView(2, T0 + 10 * MINUTE, store))
  assert.deepEqual(claimProductView(1, T0 + 31 * MINUTE, store), { sessionId: claim.sessionId }, "pasada la ventana")
})

test("envío fallido: se reintenta en la próxima apertura, nunca antes de la espera mínima", () => {
  const store = workingStore()
  const claim = claimProductView(1, T0, store)!
  settleProductView(1, claim.sessionId, false, T0 + 1_000, store)
  assert.equal(claimProductView(1, T0 + 5_000, store), null, "sin reintentos agresivos")
  const retry = claimProductView(1, T0 + 1_000 + PRODUCT_VIEW_RETRY_DELAY_MS, store)
  assert.deepEqual(retry, { sessionId: claim.sessionId }, "misma sesión: si la primera llegó, la base la marca duplicada")
  settleProductView(1, claim.sessionId, true, T0 + 40_000, store)
  assert.equal(claimProductView(1, T0 + 60_000, store), null, "tras el reintento exitoso no hay más envíos")
})

test("envío sin respuesta (pestaña cerrada): pasado el timeout puede reintentarse", () => {
  const store = workingStore()
  claimProductView(1, T0, store)
  assert.equal(claimProductView(1, T0 + PRODUCT_VIEW_PENDING_TIMEOUT_MS - 1, store), null)
  assert.ok(claimProductView(1, T0 + PRODUCT_VIEW_PENDING_TIMEOUT_MS, store))
})

test("una respuesta de otra sesión no pisa el estado de la sesión vigente", () => {
  const store = workingStore()
  const old = claimProductView(1, T0, store)!
  const fresh = claimProductView(1, T0 + 31 * MINUTE, store)!
  assert.notEqual(fresh.sessionId, old.sessionId)
  settleProductView(1, old.sessionId, true, T0 + 31 * MINUTE + 10, store)
  settleProductView(1, fresh.sessionId, false, T0 + 31 * MINUTE + 20, store)
  assert.ok(claimProductView(1, T0 + 31 * MINUTE + 20 + PRODUCT_VIEW_RETRY_DELAY_MS, store), "sigue pendiente de reintento")
})

test("estado dañado en storage: se descarta y se sigue midiendo", () => {
  const { storage, values } = memoryStorage()
  values.set(ANALYTICS_SESSION_STORAGE_KEY, "{no-json")
  values.set("beyonix-analytics-product-views", "[1,2]")
  const store = createAnalyticsStore(() => storage)
  assert.ok(claimProductView(1, T0, store))
  assert.equal(store.persistent, true, "JSON dañado no desactiva el storage")
})
