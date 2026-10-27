import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  applySystemHealthFailure,
  applySystemHealthResponse,
  createInitialSystemHealthState,
  parseSystemHealthResponse,
  presentIntegrationHealth,
  type IntegrationHealth,
  type IntegrationHealthStatus,
  type IntegrationId,
  type SystemHealthResponse,
} from "./system-health.ts"

// Estado de "Estado de integraciones" en el cliente: timestamps reales,
// último intento fallido y datos stale.

const T0 = Date.parse("2026-10-27T12:00:00.000Z")
const iso = (ms: number) => new Date(ms).toISOString()
/** Reloj de presentación dentro de la vigencia de todos los resultados de estos tests. */
const NOW = T0 + 2 * 60_000

function check(id: IntegrationId, status: IntegrationHealthStatus, at: number, detail = `detalle ${id} ${status}`): IntegrationHealth {
  return { id, label: id, status, detail, checkedAt: iso(at), latencyMs: 12 }
}

function response(at: number, statuses: Partial<Record<IntegrationId, IntegrationHealthStatus>> = {}): SystemHealthResponse {
  const ids: IntegrationId[] = ["store", "mercadopago", "andreani", "arca"]
  return {
    checks: ids.map((id) => check(id, statuses[id] ?? "ok", at)),
    checkedAt: iso(at),
    cached: false,
    pollAfterMs: 60_000,
  }
}

test("antes del primer resultado: 'Verificando', nunca 'Operativo' como placeholder", () => {
  const state = createInitialSystemHealthState()
  for (const id of ["store", "mercadopago", "andreani", "arca"] as const) {
    const view = presentIntegrationHealth(id, state, NOW)
    assert.equal(view.status, "pending")
    assert.equal(view.badge, "Verificando")
    assert.equal(view.checkedAt, null)
  }
})

test("respuesta válida: cada integración usa su checkedAt real del servidor", () => {
  const state = applySystemHealthResponse(createInitialSystemHealthState(), response(T0, { arca: "warning" }), iso(T0 + 300))
  const arca = presentIntegrationHealth("arca", state, NOW)
  assert.equal(arca.badge, "Degradado")
  assert.equal(arca.checkedAt, iso(T0), "no la hora del cliente")
  assert.equal(presentIntegrationHealth("store", state, NOW).badge, "Operativo")
})

test("fallo global del endpoint: conserva el último resultado válido sin falsear su timestamp", () => {
  const ok = applySystemHealthResponse(createInitialSystemHealthState(), response(T0), iso(T0))
  const failed = applySystemHealthFailure(ok, "No se pudo consultar el estado del sistema.", iso(T0 + 60_000))
  const store = presentIntegrationHealth("store", failed, NOW)
  assert.equal(store.badge, "Operativo")
  assert.equal(store.checkedAt, iso(T0), "checkedAt sigue siendo el de la última comprobación válida")
  assert.equal(store.lastAttemptFailed, true)
  assert.equal(failed.lastAttemptAt, iso(T0 + 60_000))
  assert.equal(failed.lastAttemptError, "No se pudo consultar el estado del sistema.")
})

test("fallo global sin resultado previo: 'No verificable', no 'Operativo'", () => {
  const failed = applySystemHealthFailure(createInitialSystemHealthState(), "Error", iso(T0))
  const view = presentIntegrationHealth("mercadopago", failed, NOW)
  assert.equal(view.status, "unknown")
  assert.equal(view.badge, "No verificable")
})

test("A: un resultado válido con checkedAt de más de 5 min vence contra el reloj, sin ningún intento nuevo", () => {
  const state = applySystemHealthResponse(createInitialSystemHealthState(), response(T0), iso(T0))
  assert.equal(presentIntegrationHealth("andreani", state, T0 + 5 * 60_000).badge, "Operativo", "justo en el límite sigue vigente")

  const expired = presentIntegrationHealth("andreani", state, T0 + 5 * 60_000 + 1)
  assert.equal(state.entries.andreani.lastAttemptFailed, false, "no hubo ningún intento fallido")
  assert.equal(expired.expired, true)
  assert.equal(expired.status, "unknown")
  assert.equal(expired.badge, "No verificable")
  assert.match(expired.detail, /últimos 5 minutos/)
  assert.equal(expired.checkedAt, iso(T0), "checkedAt sigue siendo el original del servidor")
})

test("vencimiento por integración: cada una vence según su propio checkedAt", () => {
  let state = applySystemHealthResponse(createInitialSystemHealthState(), response(T0), iso(T0))
  state = applySystemHealthResponse(state, {
    ...response(T0 + 4 * 60_000),
    checks: [check("arca", "ok", T0 + 4 * 60_000)],
  }, iso(T0 + 4 * 60_000))
  const at = T0 + 6 * 60_000
  assert.equal(presentIntegrationHealth("arca", state, at).badge, "Operativo")
  assert.equal(presentIntegrationHealth("store", state, at).badge, "No verificable")
})

test("fallos repetidos: el último intento no rejuvenece un resultado viejo", () => {
  let state = applySystemHealthResponse(createInitialSystemHealthState(), response(T0), iso(T0))
  state = applySystemHealthFailure(state, "Error", iso(T0 + 4 * 60_000))
  assert.equal(presentIntegrationHealth("andreani", state, T0 + 4 * 60_000).badge, "Operativo")
  assert.equal(presentIntegrationHealth("andreani", state, T0 + 6 * 60_000).badge, "No verificable")
  assert.equal(state.lastUpdatedAt, iso(T0), "la última actualización del panel no la mueve un fallo")
})

test("error explícito del proveedor reemplaza; 'unknown' (no determinable) conserva el último válido", () => {
  let state = applySystemHealthResponse(createInitialSystemHealthState(), response(T0), iso(T0))
  state = applySystemHealthResponse(state, response(T0 + 60_000, { mercadopago: "error", arca: "unknown" }), iso(T0 + 60_000))

  const mercadoPago = presentIntegrationHealth("mercadopago", state, NOW)
  assert.equal(mercadoPago.badge, "Caído", "el proveedor respondió con error: se actualiza")
  assert.equal(mercadoPago.lastAttemptFailed, false)

  const arca = presentIntegrationHealth("arca", state, NOW)
  assert.equal(arca.badge, "Operativo", "se conserva el último resultado válido")
  assert.equal(arca.checkedAt, iso(T0))
  assert.equal(arca.lastAttemptFailed, true)

  state = applySystemHealthResponse(state, response(T0 + 120_000), iso(T0 + 120_000))
  assert.equal(presentIntegrationHealth("arca", state, NOW).lastAttemptFailed, false, "un resultado válido limpia la marca")
})

test("'unknown' sin resultado previo se muestra como tal", () => {
  const state = applySystemHealthResponse(createInitialSystemHealthState(), response(T0, { andreani: "unknown" }), iso(T0))
  const view = presentIntegrationHealth("andreani", state, NOW)
  assert.equal(view.badge, "No verificable")
  assert.equal(view.detail, "detalle andreani unknown")
})

test("una respuesta tardía con resultados más viejos no pisa uno más nuevo", () => {
  let state = applySystemHealthResponse(createInitialSystemHealthState(), response(T0 + 60_000, { store: "error" }), iso(T0 + 60_000))
  state = applySystemHealthResponse(state, response(T0), iso(T0 + 61_000))
  assert.equal(presentIntegrationHealth("store", state, NOW).badge, "Caído")
})

test("UI: el timestamp global no se presenta como comprobación de todas las integraciones", () => {
  const source = readFileSync(new URL("../../app/admin/sections/dashboard/admin-dashboard.tsx", import.meta.url), "utf8")
  assert.match(source, /Última actualización del panel/)
  assert.doesNotMatch(source, /Última comprobación/)
  assert.match(source, /healthUpdatedAt = systemHealth\.lastUpdatedAt/)
})

test("parseo defensivo: descarta entradas inválidas y no acepta polling más agresivo que 60 s", () => {
  const parsed = parseSystemHealthResponse({
    checks: [
      check("store", "ok", T0),
      { id: "otra", status: "ok", detail: "x", checkedAt: iso(T0) },
      { id: "arca", status: "operativo", detail: "x", checkedAt: iso(T0) },
      { id: "andreani", status: "ok", detail: "x", checkedAt: "ayer" },
    ],
    checkedAt: iso(T0),
    pollAfterMs: 1_000,
  })
  assert.deepEqual(parsed?.checks.map((item) => item.id), ["store"])
  assert.equal(parsed?.pollAfterMs, 60_000)
  assert.equal(parseSystemHealthResponse({ error: "Acceso denegado." }), null)
  assert.equal(parseSystemHealthResponse(null), null)
})
