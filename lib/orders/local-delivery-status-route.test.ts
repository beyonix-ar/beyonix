import assert from "node:assert/strict"
import test, { mock } from "node:test"
import { AuthClient } from "@supabase/supabase-js"

// Bypass de Envío BEYONIX por la ruta genérica de estado
// (app/api/admin/pedidos/[id]/status): ningún rol, ni super_admin, puede
// saltar Preparando → En camino → Entregado.
type Call = { method: string; path: string; body: Record<string, unknown> | null; filters: Record<string, string> }

/** Evalúa los filtros `eq.`/`is.null` de PostgREST contra la fila actual. */
function matchesFilters(row: Record<string, unknown>, filters: Record<string, string>) {
  return Object.entries(filters).every(([column, filter]) => {
    const value = row[column]
    if (filter === "is.null") return value === null || value === undefined
    if (filter.startsWith("eq.")) return value !== null && value !== undefined && String(value) === filter.slice(3)
    return true
  })
}

/**
 * `order` es la fila en base. `afterRead` simula otro proceso que la cambia
 * entre la lectura de la ruta y su UPDATE.
 */
async function withStatusRoute(
  role: string,
  order: Record<string, unknown>,
  run: (calls: Call[], db: Record<string, unknown>) => Promise<void>,
  afterRead?: (db: Record<string, unknown>) => void,
) {
  const db = { ...order }
  const previousEnv = { ...process.env }
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://status-route.invalid"
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service"
  const calls: Call[] = []
  const claims = mock.method(AuthClient.prototype, "getClaims", async () => ({ data: { claims: { sub: "actor" } }, error: null }))
  const fetchMock = mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null
    const method = init?.method ?? "GET"
    const filters = Object.fromEntries([...url.searchParams].filter(([key]) => key !== "select"))
    calls.push({ method, path: url.pathname, body, filters })
    if (url.pathname === "/rest/v1/profiles") return Response.json({ id: "actor", email: null, rol: role })
    if (url.pathname === "/rest/v1/ordenes" && method === "GET") {
      const snapshot = { ...db }
      afterRead?.(db)
      return Response.json(snapshot)
    }
    if (url.pathname === "/rest/v1/ordenes" && method === "PATCH") {
      if (!matchesFilters(db, filters)) return Response.json([])
      Object.assign(db, body)
      return Response.json([{ ...db }])
    }
    return Response.json([])
  })
  try {
    await run(calls, db)
  } finally {
    claims.mock.restore(); fetchMock.mock.restore()
    for (const key of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"]) {
      if (previousEnv[key] === undefined) delete process.env[key]; else process.env[key] = previousEnv[key]
    }
  }
}

const patch = (estado: string) => new Request("http://localhost/api/admin/pedidos/40/status", {
  method: "PATCH",
  headers: { Authorization: "Bearer user-token", "Content-Type": "application/json" },
  body: JSON.stringify({ estado }),
})
const params = { params: Promise.resolve({ id: "40" }) }
const paidOrder = (overrides: Record<string, unknown> = {}) => ({
  id: 40, estado: "pagado", delivered_at: null, payment_status: "approved", paid_at: "2026-11-03T12:00:00.000Z",
  financial_status: "payment_confirmed", order_change_status: null, andreani_envio_id: null, andreani_estado: null,
  andreani_creation_environment: null, andreani_tracking_event_at: null, shipping_provider: "beyonix", envio_proveedor: null,
  ...overrides,
})
const orderWrites = (calls: Call[]) => calls.filter((call) => call.path === "/rest/v1/ordenes" && call.method === "PATCH")
const sideEffects = (calls: Call[]) => calls.filter((call) => call.path === "/rest/v1/order_audit_events" || call.path === "/rest/v1/orden_items")

test("super_admin: Preparando → Entregado en Envío BEYONIX => 409, sin escribir el pedido ni efectos", async () => {
  const { PATCH } = await import("../../app/api/admin/pedidos/[id]/status/route")
  await withStatusRoute("super_admin", paidOrder(), async (calls) => {
    const response = await PATCH(patch("entregado"), params)
    assert.equal(response.status, 409)
    assert.match((await response.json()).error, /Envío BEYONIX avanzan sólo desde Despachos/)
    assert.deepEqual(orderWrites(calls), [])
    assert.deepEqual(sideEffects(calls), [])
  })
})

test("super_admin: Preparando → En camino por la ruta general => 409 (tiene que usar el servicio local)", async () => {
  const { PATCH } = await import("../../app/api/admin/pedidos/[id]/status/route")
  await withStatusRoute("super_admin", paidOrder(), async (calls) => {
    assert.equal((await PATCH(patch("en_camino"), params)).status, 409)
    assert.deepEqual(orderWrites(calls), [])
  })
})

test("Envío BEYONIX: ningún despacho genérico ni salida de En camino/Entregado por la ruta general", async () => {
  const { PATCH } = await import("../../app/api/admin/pedidos/[id]/status/route")
  const cases: Array<[Record<string, unknown>, string]> = [
    [paidOrder(), "enviado"],
    [paidOrder({ estado: "en_camino" }), "entregado"],
    [paidOrder({ estado: "en_camino" }), "pagado"],
    [paidOrder({ estado: "entregado", delivered_at: "2026-11-03T15:00:00.000Z" }), "pagado"],
    [paidOrder({ estado: "entregado", delivered_at: "2026-11-03T15:00:00.000Z" }), "en_camino"],
    [paidOrder({ shipping_provider: null, envio_proveedor: "beyonix" }), "entregado"],
  ]
  for (const [order, estado] of cases) {
    await withStatusRoute("super_admin", order, async (calls) => {
      assert.equal((await PATCH(patch(estado), params)).status, 409, `${String(order.estado)} → ${estado}`)
      assert.deepEqual(orderWrites(calls), [])
    })
  }
})

test("Envío BEYONIX: un operador tampoco puede (403 por rol, antes de leer el pedido)", async () => {
  const { PATCH } = await import("../../app/api/admin/pedidos/[id]/status/route")
  await withStatusRoute("operador", paidOrder(), async (calls) => {
    assert.equal((await PATCH(patch("entregado"), params)).status, 403)
    assert.deepEqual(orderWrites(calls), [])
  })
})

test("Andreani conserva el comportamiento previo: super_admin puede forzar En camino", async () => {
  const { PATCH } = await import("../../app/api/admin/pedidos/[id]/status/route")
  await withStatusRoute("super_admin", paidOrder({ shipping_provider: "andreani", andreani_envio_id: "360000" }), async (calls) => {
    assert.equal((await PATCH(patch("en_camino"), params)).status, 200)
    assert.deepEqual(orderWrites(calls).map((call) => call.body?.estado), ["en_camino"])
  })
})

test("pedido no local (transportista manual) conserva la lógica general: despacho permitido", async () => {
  const { PATCH } = await import("../../app/api/admin/pedidos/[id]/status/route")
  await withStatusRoute("operador", paidOrder({ shipping_provider: null, envio_proveedor: "Otro" }), async (calls) => {
    assert.equal((await PATCH(patch("enviado"), params)).status, 200)
    assert.deepEqual(orderWrites(calls).map((call) => call.body?.estado), ["enviado"])
  })
})

// ── Carreras: el UPDATE de la ruta general es condicional ───────────────────

const andreaniOrder = (overrides: Record<string, unknown> = {}) =>
  paidOrder({ shipping_provider: "andreani", andreani_envio_id: "360000", payment_confirmed_amount: 45_000, cancelled_at: null, ...overrides })

test("carrera A: otro proceso cancela entre la lectura y el UPDATE => 409 y la cancelación no se pisa", async () => {
  const { PATCH } = await import("../../app/api/admin/pedidos/[id]/status/route")
  await withStatusRoute("super_admin", andreaniOrder(), async (calls, db) => {
    const response = await PATCH(patch("en_camino"), params)
    assert.equal(response.status, 409)
    assert.match((await response.json()).error, /El pedido cambió/)
    assert.equal(orderWrites(calls).length, 1, "intentó un único UPDATE condicional")
    assert.deepEqual([db.estado, db.financial_status, db.cancelled_at], ["cancelado", "cancelled", "2026-11-03T15:00:00.000Z"])
    assert.deepEqual(sideEffects(calls), [], "sin auditoría, garantía ni email")
  }, (db) => Object.assign(db, { estado: "cancelado", financial_status: "cancelled", cancelled_at: "2026-11-03T15:00:00.000Z" }))
})

test("carrera B: otro proceso cambia el estado (p. ej. ya lo entregó) => 409", async () => {
  const { PATCH } = await import("../../app/api/admin/pedidos/[id]/status/route")
  await withStatusRoute("super_admin", andreaniOrder(), async (_calls, db) => {
    assert.equal((await PATCH(patch("en_camino"), params)).status, 409)
    assert.equal(db.estado, "entregado")
  }, (db) => Object.assign(db, { estado: "entregado", delivered_at: "2026-11-03T15:00:00.000Z" }))
})

test("carrera C: cambia financial_status (refund_pending) o la evidencia de pago => 409", async () => {
  const { PATCH } = await import("../../app/api/admin/pedidos/[id]/status/route")
  for (const change of [{ financial_status: "refund_pending" }, { payment_status: "approved_amount_mismatch" }, { order_change_status: "change_requested" }]) {
    await withStatusRoute("super_admin", andreaniOrder(), async (_calls, db) => {
      assert.equal((await PATCH(patch("en_camino"), params)).status, 409, JSON.stringify(change))
      assert.equal(db.estado, "pagado")
    }, (db) => Object.assign(db, change))
  }
})

test("carrera: un pedido que pasa a Envío BEYONIX entre la lectura y el UPDATE tampoco se despacha por la ruta general", async () => {
  const { PATCH } = await import("../../app/api/admin/pedidos/[id]/status/route")
  await withStatusRoute("super_admin", andreaniOrder({ andreani_envio_id: null, shipping_provider: null, envio_proveedor: "Otro" }), async (_calls, db) => {
    assert.equal((await PATCH(patch("enviado"), params)).status, 409)
    assert.equal(db.estado, "pagado")
  }, (db) => Object.assign(db, { shipping_provider: "beyonix" }))
})

test("carrera D: Andreani sin cambios concurrentes avanza como antes, con el WHERE sobre lo leído", async () => {
  const { PATCH } = await import("../../app/api/admin/pedidos/[id]/status/route")
  await withStatusRoute("super_admin", andreaniOrder(), async (calls, db) => {
    assert.equal((await PATCH(patch("en_camino"), params)).status, 200)
    assert.equal(db.estado, "en_camino")
    const [write] = orderWrites(calls)
    assert.deepEqual(
      [write.filters.id, write.filters.estado, write.filters.cancelled_at, write.filters.financial_status, write.filters.shipping_provider, write.filters.payment_status],
      ["eq.40", "eq.pagado", "is.null", "eq.payment_confirmed", "eq.andreani", "eq.approved"],
    )
    assert.ok(calls.some((call) => call.path === "/rest/v1/order_audit_events"), "audita el cambio como antes")
  })
})
