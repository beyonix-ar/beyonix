import assert from "node:assert/strict"
import test, { mock } from "node:test"
import { JSDOM } from "jsdom"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"

import { INTEGRATION_ORDER, type SystemHealthResponse } from "@/lib/admin/system-health"
import type { DashboardDataResponse } from "@/lib/supabase/queries/dashboard"

// "Estado de integraciones" (Admin > Dashboard): carrera entre la carga
// general y el health check, y ciclo de polling. Hooks reales con JSDOM.

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://localhost" })
for (const [key, value] of Object.entries({
  window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, key, { value, writable: true, configurable: true })

let visibility: DocumentVisibilityState = "visible"
Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility })

// GoTrue abre un BroadcastChannel (sincronización entre pestañas) que dejaría
// el proceso de test vivo; estos tests no usan la sesión real.
Object.defineProperty(globalThis, "BroadcastChannel", { value: undefined, writable: true, configurable: true })
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://health-tests.invalid"
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon"

// El cliente de Supabase lee las variables al importarse: carga diferida.
let useSystemHealth: typeof import("./use-system-health").useSystemHealth
let useDashboard: typeof import("./use-dashboard").useDashboard
test.before(async () => {
  ;({ useSystemHealth } = await import("./use-system-health"))
  ;({ useDashboard } = await import("./use-dashboard"))
})

type HealthCall = { force: boolean; signal: AbortSignal; resolve: (value: SystemHealthResponse) => void; reject: (error: Error) => void }

function healthResponse(statuses: Partial<Record<string, SystemHealthResponse["checks"][number]["status"]>> = {}): SystemHealthResponse {
  const at = new Date(Date.now()).toISOString()
  return {
    checks: INTEGRATION_ORDER.map((id) => ({ id, label: id, status: statuses[id] ?? "ok", detail: `real ${id}`, checkedAt: at, latencyMs: 10 })),
    checkedAt: at,
    cached: false,
    pollAfterMs: 60_000,
  }
}

/** Dashboard general con un systemStatus preliminar (forma vieja del endpoint). */
function dashboardPayload(): DashboardDataResponse {
  return {
    role: "admin",
    stats: null,
    financialSummary: null,
    lowStock: [],
    recentOrders: [],
    commercialSales: [],
    recentActivity: [],
    searchIndex: [],
    systemStatus: INTEGRATION_ORDER.map((id) => ({ id, label: id, status: "ok", detail: "Comprobación en segundo plano" })),
  } as unknown as DashboardDataResponse
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}

interface Snapshot {
  health: ReturnType<typeof useSystemHealth>
  dashboard: ReturnType<typeof useDashboard>
}

async function mount() {
  const healthCalls: HealthCall[] = []
  const dashboardCalls: Array<ReturnType<typeof deferred<DashboardDataResponse>> & { force: boolean }> = []
  const fetchHealth = ({ force, signal }: { force: boolean; signal: AbortSignal }) => {
    const call = deferred<SystemHealthResponse>()
    healthCalls.push({ force, signal, resolve: call.resolve, reject: call.reject })
    return call.promise
  }
  const load = ({ force = false }: { force?: boolean }) => {
    const call = deferred<DashboardDataResponse>()
    dashboardCalls.push({ ...call, force })
    return call.promise
  }
  let latest: Snapshot | null = null
  function Harness() {
    const health = useSystemHealth({ fetchHealth, intervalMs: 60_000, tickMs: 1_000 })
    const dashboard = useDashboard({ load })
    latest = { health, dashboard }
    return null
  }
  const root: Root = createRoot(document.getElementById("root")!)
  await act(async () => { root.render(<Harness />) })
  return {
    healthCalls,
    dashboardCalls,
    root,
    get current() {
      assert.ok(latest)
      return latest
    },
    /** Lo que ve el usuario: la presentación del hook con su reloj. */
    views() {
      assert.ok(latest)
      return latest.health.items
    },
  }
}

async function settle(run: () => void) {
  await act(async () => {
    run()
    await Promise.resolve()
  })
}

async function advance(ms: number) {
  await act(async () => {
    mock.timers.tick(ms)
    await Promise.resolve()
  })
}

function enableClock() {
  mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: Date.parse("2026-10-27T12:00:00.000Z") })
}

test.afterEach(() => {
  mock.timers.reset()
  visibility = "visible"
})

test.after(async () => {
  // El cliente de Supabase deja un timer de auto-refresh que mantendría vivo el proceso.
  const { supabase } = await import("@/lib/supabase/client")
  await supabase.auth.stopAutoRefresh()
  dom.window.close()
})

test("race A: dashboard general termina primero y luego health -> gana health", async () => {
  enableClock()
  const harness = await mount()
  await settle(() => harness.dashboardCalls[0].resolve(dashboardPayload()))
  await settle(() => harness.healthCalls[0].resolve(healthResponse({ andreani: "error" })))
  assert.deepEqual(harness.views().map((view) => view.badge), ["Operativo", "Operativo", "Caído", "Operativo"])
  assert.equal(harness.views()[2].detail, "real andreani")
  await act(async () => { harness.root.unmount() })
})

test("race B: health termina primero y luego el dashboard general -> health sigue ganando", async () => {
  enableClock()
  const harness = await mount()
  await settle(() => harness.healthCalls[0].resolve(healthResponse({ andreani: "unknown" })))
  const before = harness.current.health.state
  await settle(() => harness.dashboardCalls[0].resolve(dashboardPayload()))
  assert.equal(harness.current.health.state, before, "la carga general no toca el estado de health")
  assert.equal(harness.views()[2].badge, "No verificable")
  assert.ok(!("systemStatus" in harness.current.dashboard), "el payload general no expone estados preliminares")
  await act(async () => { harness.root.unmount() })
})

test("race C: reload manual del dashboard no restaura estados preliminares", async () => {
  enableClock()
  const harness = await mount()
  await settle(() => harness.dashboardCalls[0].resolve(dashboardPayload()))
  await settle(() => harness.healthCalls[0].resolve(healthResponse({ mercadopago: "error" })))
  const before = harness.current.health.state
  await act(async () => { void harness.current.dashboard.reloadDashboard() })
  assert.equal(harness.dashboardCalls.at(-1)?.force, true)
  await settle(() => harness.dashboardCalls.at(-1)!.resolve(dashboardPayload()))
  assert.equal(harness.current.health.state, before)
  assert.equal(harness.views()[1].badge, "Caído")
  await act(async () => { harness.root.unmount() })
})

test("race D: un error del dashboard general no destruye un health válido", async () => {
  enableClock()
  const harness = await mount()
  await settle(() => harness.healthCalls[0].resolve(healthResponse()))
  const before = harness.current.health.state
  const warn = mock.method(console, "warn", () => undefined)
  await settle(() => harness.dashboardCalls[0].reject(new Error("HTTP 500")))
  warn.mock.restore()
  assert.equal(harness.current.dashboard.error, "No se pudo cargar el dashboard.")
  assert.equal(harness.current.health.state, before)
  assert.deepEqual(harness.views().map((view) => view.badge), ["Operativo", "Operativo", "Operativo", "Operativo"])
  await act(async () => { harness.root.unmount() })
})

test("stale: un fallo posterior conserva el resultado válido y su checkedAt real", async () => {
  enableClock()
  const harness = await mount()
  await settle(() => harness.healthCalls[0].resolve(healthResponse()))
  const firstCheckedAt = harness.views()[0].checkedAt
  await advance(60_000)
  assert.equal(harness.healthCalls.length, 2)
  await settle(() => harness.healthCalls[1].reject(new Error("No se pudo consultar el estado del sistema.")))
  const store = harness.views()[0]
  assert.equal(store.badge, "Operativo")
  assert.equal(store.checkedAt, firstCheckedAt, "no se inventa un timestamp nuevo")
  assert.equal(store.lastAttemptFailed, true)
  assert.equal(harness.current.health.state.lastAttemptError, "No se pudo consultar el estado del sistema.")
  await act(async () => { harness.root.unmount() })
})

test("vencimiento A: sin ninguna respuesta nueva, un 'Operativo' de más de 5 min deja de mostrarse vigente", async () => {
  enableClock()
  const harness = await mount()
  await settle(() => harness.healthCalls[0].resolve(healthResponse()))
  const checkedAt = harness.views()[0].checkedAt
  await advance(60_000)
  assert.equal(harness.healthCalls.length, 2, "el siguiente intento queda colgado: no hay respuesta nueva")
  await advance(3 * 60_000)
  assert.equal(harness.views()[0].badge, "Operativo", "dentro de los 5 min sigue vigente")
  await advance(2 * 60_000 + 10_000)
  assert.equal(harness.healthCalls.length, 2, "sigue sin requests nuevos")
  assert.deepEqual(harness.views().map((view) => view.badge), ["No verificable", "No verificable", "No verificable", "No verificable"])
  assert.equal(harness.views()[0].checkedAt, checkedAt, "checkedAt original intacto")
  await act(async () => { harness.root.unmount() })
})

test("vencimiento B: la pestaña vuelve tras más de 5 min y no muestra el 'Operativo' viejo como vigente", async () => {
  enableClock()
  const harness = await mount()
  await settle(() => harness.healthCalls[0].resolve(healthResponse({ arca: "warning" })))
  visibility = "hidden"
  // Pestaña suspendida / equipo dormido: el timer no corre; sólo avanza el reloj.
  mock.timers.setTime(Date.now() + 7 * 60_000)
  visibility = "visible"
  await act(async () => {
    document.dispatchEvent(new dom.window.Event("visibilitychange"))
    await Promise.resolve()
  })
  assert.equal(harness.healthCalls.length, 2, "una sola consulta al volver")
  assert.deepEqual(
    harness.views().map((view) => view.badge),
    ["No verificable", "No verificable", "No verificable", "No verificable"],
    "mientras llega la respuesta nueva no se muestra el resultado viejo como vigente",
  )
  await settle(() => harness.healthCalls[1].resolve(healthResponse()))
  assert.equal(harness.views()[0].badge, "Operativo", "la respuesta nueva vuelve a ser vigente")
  await act(async () => { harness.root.unmount() })
})

test("polling: primera comprobación al montar, luego cada 60 s (no 30 s)", async () => {
  enableClock()
  const harness = await mount()
  assert.equal(harness.healthCalls.length, 1)
  assert.equal(harness.healthCalls[0].force, false)
  await settle(() => harness.healthCalls[0].resolve(healthResponse()))
  await advance(30_000)
  assert.equal(harness.healthCalls.length, 1, "nada a los 30 s")
  await advance(29_000)
  assert.equal(harness.healthCalls.length, 1)
  await advance(1_000)
  assert.equal(harness.healthCalls.length, 2, "a los 60 s")
  await act(async () => { harness.root.unmount() })
})

test("polling: pestaña oculta no consulta; al volver, una sola consulta", async () => {
  enableClock()
  const harness = await mount()
  await settle(() => harness.healthCalls[0].resolve(healthResponse()))
  visibility = "hidden"
  await advance(5 * 60_000)
  assert.equal(harness.healthCalls.length, 1, "oculta: cero consultas")
  visibility = "visible"
  await act(async () => {
    document.dispatchEvent(new dom.window.Event("visibilitychange"))
    document.dispatchEvent(new dom.window.Event("visibilitychange"))
    mock.timers.tick(1_000)
    await Promise.resolve()
  })
  assert.equal(harness.healthCalls.length, 2, "una sola al volver")
  await act(async () => { harness.root.unmount() })
})

test("polling: sin requests concurrentes y 'Comprobar ahora' no duplica", async () => {
  enableClock()
  const harness = await mount()
  assert.equal(harness.current.health.refreshing, true)
  await act(async () => {
    void harness.current.health.refreshNow()
    void harness.current.health.refreshNow()
    mock.timers.tick(120_000)
    await Promise.resolve()
  })
  assert.equal(harness.healthCalls.length, 1, "se suma al ciclo en curso")
  await settle(() => harness.healthCalls[0].resolve(healthResponse()))
  assert.equal(harness.current.health.refreshing, false)

  await act(async () => {
    void harness.current.health.refreshNow()
    void harness.current.health.refreshNow()
    await Promise.resolve()
  })
  assert.equal(harness.healthCalls.length, 2)
  assert.equal(harness.healthCalls[1].force, true, "manual fuerza una comprobación real")
  await act(async () => { harness.root.unmount() })
})

test("polling: desmontar limpia el timer y aborta el ciclo en curso", async () => {
  enableClock()
  const harness = await mount()
  const inFlight = harness.healthCalls[0]
  await act(async () => { harness.root.unmount() })
  assert.equal(inFlight.signal.aborted, true)
  await advance(10 * 60_000)
  assert.equal(harness.healthCalls.length, 1)
})
