import assert from "node:assert/strict"
import test, { mock } from "node:test"
import { AuthClient } from "@supabase/supabase-js"

import { DISPATCH_ORDER_ACTIONS, DISPATCH_TEST_ORDER_CONSULT_ERROR, DISPATCH_TEST_ORDER_ERROR } from "./dispatch"

// Despachos sin compras de prueba (ordenes.test_order_at): las listas las
// excluyen en la consulta y ninguna acción las opera. Supabase simulado: la
// respuesta respeta el filtro `test_order_at=is.null`, así que si la ruta
// dejara de pedirlo la compra de prueba volvería a aparecer.

type Call = { method: string; path: string; body: unknown; filters: Record<string, string> }
type Responder = (call: Call) => Response | undefined

const SUPABASE = "https://dispatch-test-orders.invalid"
const TEST_AT = "2026-11-24T13:00:00.000Z"

async function withSupabase(run: (calls: Call[]) => Promise<void>, responder: Responder, role = "operador") {
  const previousEnv = { ...process.env }
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service"
  const calls: Call[] = []
  const claims = mock.method(AuthClient.prototype, "getClaims", async () => ({ data: { claims: { sub: "actor" } }, error: null }))
  const fetchMock = mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : null
    const call = { method: init?.method ?? "GET", path: url.pathname, body, filters: Object.fromEntries([...url.searchParams].filter(([name]) => name !== "select")) }
    calls.push(call)
    if (call.path === "/rest/v1/profiles") return Response.json({ id: "actor", email: null, rol: role })
    return responder(call) ?? Response.json([])
  })
  try {
    await run(calls)
  } finally {
    claims.mock.restore(); fetchMock.mock.restore()
    for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key]
    Object.assign(process.env, previousEnv)
  }
}

/** Lo que haría PostgREST: con `test_order_at=is.null`, sin compras de prueba. */
const honorTestFilter = <T extends { test_order_at: string | null }>(call: Call, rows: T[]) =>
  call.filters.test_order_at === "is.null" ? rows.filter((row) => row.test_order_at === null) : rows
const ordenesReads = (calls: Call[]) => calls.filter((call) => call.method === "GET" && call.path === "/rest/v1/ordenes")
const rpcs = (calls: Call[]) => calls.filter((call) => call.path.startsWith("/rest/v1/rpc/")).map((call) => call.path.replace("/rest/v1/rpc/", ""))
const writes = (calls: Call[]) => calls.filter((call) => ["POST", "PATCH", "PUT", "DELETE"].includes(call.method) && !call.path.startsWith("/rest/v1/rpc/"))
const get = (path: string) => new Request(`http://localhost/api/admin/dispatch${path}`, { headers: { Authorization: "Bearer user-token" } })
const post = (path: string, body: unknown) => new Request(`http://localhost/api/admin/dispatch${path}`, {
  method: "POST", headers: { Authorization: "Bearer user-token", "Content-Type": "application/json" }, body: JSON.stringify(body),
})

test("Entregas locales GET: ni cola ni entregados recientes muestran compras de prueba (BX-1020 entregado hace 2 días)", async () => {
  const { GET } = await import("../../app/api/admin/dispatch/local/route")
  const recent = new Date(Date.now() - 2 * 86_400_000).toISOString()
  const row = (id: number, estado: string, testOrderAt: string | null) => ({ id, estado, created_at: recent, paid_at: recent,
    delivered_at: estado === "entregado" ? recent : null, cliente_nombre: `Cliente ${id}`, cliente_telefono: null,
    cliente_direccion: "Mitre 10", localidad: "Rosario", cp_destino: "2000", test_order_at: testOrderAt })
  const rows = [row(20, "entregado", TEST_AT), row(50, "entregado", null), row(51, "pagado", null), row(61, "pagado", TEST_AT)]
  await withSupabase(async (calls) => {
    const response = await GET(get("/local"))
    assert.equal(response.status, 200)
    const { orders } = await response.json() as { orders: Array<{ id: number }> }
    assert.deepEqual(orders.map((order) => order.id).sort(), [50, 51])
    const reads = ordenesReads(calls)
    assert.equal(reads.length, 2, "cola por id y entregados recientes")
    assert.ok(reads.every((call) => call.filters.test_order_at === "is.null"), JSON.stringify(reads.map((call) => call.filters)))
    assert.deepEqual(writes(calls), [])
  }, (call) => {
    // La cola de la base ya excluye pruebas; aquí se simula una cola que incluyera la 61 para probar la segunda barrera.
    if (call.path === "/rest/v1/rpc/local_delivery_queue_order_ids") return Response.json((call.body as { p_queue: string }).p_queue === "operational" ? [51, 61] : [])
    if (call.path === "/rest/v1/ordenes") {
      const scoped = call.filters.estado === "eq.entregado" ? rows.filter((item) => item.estado === "entregado")
        : rows.filter((item) => (call.filters.id ?? "").replace(/^in\.\(|\)$/g, "").split(",").map(Number).includes(item.id))
      return Response.json(honorTestFilter(call, scoped))
    }
    return undefined
  })
})

test("tablero de Despachos GET: la cola activa nunca incluye compras de prueba", async () => {
  const { GET } = await import("../../app/api/admin/dispatch/route")
  const order = (id: number, testOrderAt: string | null) => ({ id, estado: "pagado", financial_status: "payment_confirmed", payment_status: "approved",
    shipping_provider: "andreani", envio_proveedor: null, cancelled_at: null, andreani_handed_over_at: null, created_at: "2026-11-24T12:00:00.000Z",
    total: 1000, test_order_at: testOrderAt })
  await withSupabase(async (calls) => {
    const response = await GET(get(""))
    assert.equal(response.status, 200)
    const { orders } = await response.json() as { orders: Array<{ id: number }> }
    assert.deepEqual(orders.map((item) => item.id), [1])
    const queue = ordenesReads(calls).find((call) => call.filters.financial_status === "eq.payment_confirmed")
    assert.equal(queue?.filters.test_order_at, "is.null")
  }, (call) => call.path === "/rest/v1/ordenes" && call.filters.financial_status === "eq.payment_confirmed"
    ? Response.json(honorTestFilter(call, [order(1, null), order(2, TEST_AT)])) : undefined)
})

const LOCAL_ACTIONS = ["en_camino", "entregado", "retry_effects", "revert_in_transit", "incident_retry", "incident_return"]

test("Entregas locales POST: ninguna acción opera una compra de prueba (sin RPC ni escrituras); un pedido real sigue operándose", async () => {
  const { POST } = await import("../../app/api/admin/dispatch/local/route")
  for (const action of LOCAL_ACTIONS) {
    await withSupabase(async (calls) => {
      const response = await POST(post("/local", { orderId: 20, action, reason: "Se marcó por error, el pedido sigue acá.", requestKey: "55555555-5555-4555-8555-555555555555" }))
      assert.equal(response.status, 409, action)
      assert.equal((await response.json() as { error: string }).error, DISPATCH_TEST_ORDER_ERROR, action)
      assert.deepEqual(rpcs(calls), [], action)
      assert.deepEqual(writes(calls), [], action)
    }, (call) => call.path === "/rest/v1/ordenes" ? Response.json({ test_order_at: TEST_AT }) : undefined, "super_admin")
  }
  await withSupabase(async (calls) => {
    assert.equal((await POST(post("/local", { orderId: 41, action: "incident_return" }))).status, 200)
    assert.deepEqual(rpcs(calls), ["resolve_local_delivery_incident"])
  }, (call) => call.path === "/rest/v1/ordenes" ? Response.json({ test_order_at: null }) : undefined)
  // Sin poder verificar el pedido no se ejecuta nada.
  await withSupabase(async (calls) => {
    assert.equal((await POST(post("/local", { orderId: 41, action: "incident_return" }))).status, 500)
    assert.deepEqual(rpcs(calls), [])
  }, (call) => call.path === "/rest/v1/ordenes" ? Response.json({ message: "boom" }, { status: 500 }) : undefined)
})

test("acciones del pedido en Despachos: ninguna opera una compra de prueba; un pedido real pasa la guarda", async () => {
  const { POST } = await import("../../app/api/admin/dispatch/orders/[id]/route")
  const params = { params: Promise.resolve({ id: "20" }) }
  const order = (testOrderAt: string | null) => ({ estado: "pagado", cancelled_at: null, financial_status: "payment_confirmed",
    andreani_envio_id: null, shipping_provider: "beyonix", envio_proveedor: null, test_order_at: testOrderAt })
  for (const action of DISPATCH_ORDER_ACTIONS) {
    await withSupabase(async (calls) => {
      const response = await POST(post("/orders/20", { action, requestKey: "55555555-5555-4555-8555-555555555555", code: "BX-PKG-1020-01" }), params)
      assert.equal(response.status, 409, action)
      assert.equal((await response.json() as { error: string }).error, DISPATCH_TEST_ORDER_ERROR, action)
      assert.deepEqual(rpcs(calls), [], action)
      assert.deepEqual(writes(calls), [], action)
    }, (call) => call.path === "/rest/v1/ordenes" ? Response.json(order(TEST_AT)) : undefined, "super_admin")
  }
  await withSupabase(async () => {
    const response = await POST(post("/orders/20", { action: "start", requestKey: "55555555-5555-4555-8555-555555555555" }), params)
    assert.notEqual((await response.json() as { error?: string }).error, DISPATCH_TEST_ORDER_ERROR)
  }, (call) => call.path === "/rest/v1/ordenes" ? Response.json(order(null)) : undefined)
})

// ── Etiquetas y QR: ninguna operación nueva; consulta histórica sólo Super Admin ──

const QR_TOKEN = "tokenDePruebaAbCdEfGhIjK"
const labelOrder = (testOrderAt: string | null) => ({ id: 20, estado: "entregado", cancelled_at: null, financial_status: "payment_confirmed",
  shipping_provider: "beyonix", envio_proveedor: null, cliente_nombre: "María José Peña", cliente_direccion: "Córdoba 1234", localidad: "Rosario",
  provincia: "Santa Fe", cp_destino: "2000", cliente_telefono: "341 555-0000", test_order_at: testOrderAt })
const labelResponder = (testOrderAt: string | null): Responder => (call) => {
  if (call.path === "/rest/v1/ordenes") return Response.json(labelOrder(testOrderAt))
  if (call.path === "/rest/v1/local_delivery_shipments") return Response.json({ id: 7, access_token: QR_TOKEN, token_revoked_at: null, outcome_status: "delivered", failed_attempts: 0 })
  if (call.path === "/rest/v1/order_audit_events" && call.method === "POST") return new Response(null, { status: 201 })
  return undefined
}
const params20 = { params: Promise.resolve({ id: "20" }) }

test("etiquetas BEYONIX de una compra de prueba: nadie las genera ni reimprime (ni Super Admin); sin token, RPC ni historial nuevo", async () => {
  const { POST } = await import("../../app/api/admin/dispatch/orders/[id]/local-label/route")
  for (const role of ["operador", "admin", "super_admin"]) {
    await withSupabase(async (calls) => {
      const response = await POST(post("/orders/20/local-label", {}), params20)
      assert.equal(response.status, 409, role)
      assert.equal((await response.json() as { error: string }).error, DISPATCH_TEST_ORDER_ERROR, role)
      assert.deepEqual(rpcs(calls), [], role)
      assert.deepEqual(writes(calls), [], role)
    }, labelResponder(TEST_AT), role)
  }
})

test("QR del cadete de una compra de prueba: Super Admin consulta el historial; operador y Admin no", async () => {
  const { POST } = await import("../../app/api/admin/dispatch/orders/[id]/courier-qr/route")
  for (const role of ["operador", "admin"]) {
    await withSupabase(async (calls) => {
      const response = await POST(post("/orders/20/courier-qr", {}), params20)
      assert.equal(response.status, 409, role)
      const payload = await response.json() as { error: string; url?: string }
      assert.deepEqual([payload.error, payload.url], [DISPATCH_TEST_ORDER_CONSULT_ERROR, undefined], role)
      assert.deepEqual(writes(calls), [], role)
    }, labelResponder(TEST_AT), role)
  }
  await withSupabase(async () => {
    const response = await POST(post("/orders/20/courier-qr", {}), params20)
    assert.equal(response.status, 200)
    const payload = await response.json() as { courierCanAct: boolean; orderCode: string }
    assert.deepEqual([payload.orderCode, payload.courierCanAct], ["BX-1020", false], "entregado: el cadete ya no puede registrar nada")
  }, labelResponder(TEST_AT), "super_admin")
  // Pedido real: sin cambios para operador.
  await withSupabase(async () => {
    assert.equal((await POST(post("/orders/20/courier-qr", {}), params20)).status, 200)
  }, labelResponder(null), "operador")
})

test("etiqueta Andreani de una compra de prueba: sólo Super Admin la consulta; sin llamar a Andreani para el resto", async () => {
  const { POST } = await import("../../app/api/admin/dispatch/orders/[id]/andreani-label/route")
  for (const role of ["operador", "admin"]) {
    await withSupabase(async (calls) => {
      const response = await POST(post("/orders/20/andreani-label", {}), params20)
      assert.equal(response.status, 409, role)
      assert.equal((await response.json() as { error: string }).error, DISPATCH_TEST_ORDER_CONSULT_ERROR, role)
      assert.ok(calls.every((call) => call.path.startsWith("/rest/v1/")), "ninguna llamada a Andreani")
      assert.deepEqual(writes(calls), [], role)
    }, (call) => call.path === "/rest/v1/ordenes" ? Response.json({ test_order_at: TEST_AT }) : undefined, role)
  }
  // Super Admin pasa la guarda (lo que siga depende de la etiqueta en Andreani, no de esta regla).
  await withSupabase(async () => {
    const response = await POST(post("/orders/20/andreani-label", {}), params20)
    if (!response.ok) assert.notEqual((await response.json() as { error: string }).error, DISPATCH_TEST_ORDER_CONSULT_ERROR)
  }, (call) => call.path === "/rest/v1/ordenes" ? Response.json({ test_order_at: TEST_AT }) : undefined, "super_admin")
})

// ── Cron local-delivery-effects ─────────────────────────────────────────────

test("cron de efectos: la selección excluye compras de prueba y una clasificada después de seleccionarla no recibe efectos ni emails", async () => {
  const { GET } = await import("../../app/api/cron/local-delivery-effects/route")
  const marker = (orderId: number, effect: string, state: string, attemptId: string | null = null) =>
    ({ order_id: orderId, action: "x", created_at: "2026-11-05T10:00:00.000Z", metadata: { localDeliveryEffect: effect, localDeliveryEffectState: state, ...(attemptId ? { attemptId } : {}) } })
  // 61 y 64: entregados con el email de Entregado fallado una vez (pendiente reintentable).
  const pendingEmail = (orderId: number) => [
    ...["in_transit_status", "delivered_warranty", "delivered_status"].map((effect) => marker(orderId, effect, "completed")),
    marker(orderId, "in_transit_email", "superseded"), marker(orderId, "delivered_email", "reserved", `a${orderId}`), marker(orderId, "delivered_email", "failed", `a${orderId}`),
  ]
  const markers = [...pendingEmail(61), ...pendingEmail(64)]
  const order = (id: number, testOrderAt: string | null) => ({ id, estado: "entregado", shipping_provider: "beyonix", envio_proveedor: "beyonix",
    delivered_at: "2026-11-05T09:00:00.000Z", cancelled_at: null, financial_status: "payment_confirmed", order_change_status: null,
    paid_at: "2026-11-05T08:00:00.000Z", payment_status: "approved", payment_confirmed_amount: 20, shipping_cost_real: 0,
    cliente_email: "cliente@example.com", cliente_nombre: "Cliente", test_order_at: testOrderAt })
  // 64 es prueba desde antes; 61 se clasifica justo DESPUÉS de que el cron lo seleccionó.
  let classifiedAfterSelection = false
  await withSupabase(async (calls) => {
    process.env.CRON_SECRET = "cron-secret-de-prueba"
    delete process.env.RESEND_API_KEY
    const response = await GET(new Request("http://localhost/api/cron/local-delivery-effects", { headers: { Authorization: "Bearer cron-secret-de-prueba" } }))
    assert.equal(response.status, 200)
    const candidates = calls.find((call) => call.path === "/rest/v1/ordenes" && call.filters.estado === "in.(en_camino,entregado)")
    assert.equal(candidates?.filters.test_order_at, "is.null", "la selección ya excluye pruebas")
    const summary = await response.json() as { checked: number; attempted: number; completed: number }
    assert.equal(summary.checked, 1, "sólo 61 seleccionado (64 quedó afuera)")
    assert.equal(summary.completed, 0)
    assert.deepEqual(calls.filter((call) => call.method === "POST" && call.path === "/rest/v1/order_audit_events"), [], "ni reservas ni marcas")
    assert.equal(calls.some((call) => !call.path.startsWith("/rest/v1/")), false, "ningún llamado al proveedor de email")
    assert.equal(calls.some((call) => call.method === "PATCH"), false)
  }, (call) => {
    if (call.path === "/rest/v1/ordenes") {
      if (call.filters.estado === "in.(en_camino,entregado)") {
        const rows = [{ id: 61, estado: "entregado", delivered_at: "2026-11-05T09:00:00.000Z", test_order_at: null },
          { id: 64, estado: "entregado", delivered_at: "2026-11-05T09:00:00.000Z", test_order_at: TEST_AT }]
        classifiedAfterSelection = true
        return Response.json(honorTestFilter(call, rows))
      }
      const id = Number((call.filters.id ?? "").replace("eq.", ""))
      return Response.json(order(id, id === 64 || classifiedAfterSelection ? TEST_AT : null))
    }
    if (call.path === "/rest/v1/order_audit_events" && call.method === "GET") {
      const filter = call.filters.order_id ?? ""
      const ids = filter.startsWith("in.") ? filter.replace(/^in\.\(|\)$/g, "").split(",").map(Number) : [Number(filter.replace("eq.", ""))]
      return Response.json(markers.filter((row) => ids.includes(row.order_id)))
    }
    if (call.path === "/rest/v1/local_delivery_shipments") return Response.json(null)
    return undefined
  })
})
