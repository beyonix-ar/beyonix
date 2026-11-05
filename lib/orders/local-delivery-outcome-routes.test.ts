import assert from "node:assert/strict"
import test, { mock } from "node:test"
import { AuthClient } from "@supabase/supabase-js"

// Rutas del resultado de entrega Envío BEYONIX: página/acción del cadete (QR,
// sin login), recepción de devoluciones locales, incidencias en Despachos y el
// job de vencimiento de reservas. Supabase y el proveedor de email simulados.

type Call = { method: string; path: string; body: unknown; filters: Record<string, string> }
type Responder = (call: Call) => Response | undefined

const SUPABASE = "https://local-delivery-outcome.invalid"
const TOKEN = "QrTokenDePrueba1234567890"

async function withSupabase(run: (calls: Call[]) => Promise<void>, responder: Responder, role = "operador") {
  const previousEnv = { ...process.env }
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service"
  process.env.CRON_SECRET = "cron-secret-de-prueba"
  delete process.env.RESEND_API_KEY
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

const rpcError = (message: string, details: string | null = null) => Response.json({ code: "P0001", message, details, hint: null }, { status: 400 })

interface CourierState {
  estado: string
  outcome: string
  failedAttempts: number
}

/** Base simulada del cadete: shipment por token, pedido mínimo y bultos. */
function courierDb(state: CourierState, rpc: Record<string, (call: Call) => Response> = {}): Responder {
  return (call) => {
    if (call.path.startsWith("/rest/v1/rpc/")) return rpc[call.path.replace("/rest/v1/rpc/", "")]?.(call) ?? Response.json(null)
    if (call.path === "/rest/v1/local_delivery_shipments") {
      // Consulta de "entrega más nueva" (nuevo envío): no hay.
      if (call.filters.shipment_number) return Response.json([])
      if (call.filters.access_token !== `eq.${TOKEN}`) return Response.json(null)
      return Response.json({ id: 7, order_id: 41, shipment_number: 1, outcome_status: state.outcome, failed_attempts: state.failedAttempts })
    }
    if (call.path === "/rest/v1/ordenes") {
      return Response.json({
        id: 41, estado: state.estado, cancelled_at: null, financial_status: "payment_confirmed", shipping_provider: "beyonix", envio_proveedor: null,
        cliente_nombre: "María José Peña", cliente_direccion: "Córdoba 1234. Referencias: Portón verde", localidad: "Rosario", cp_destino: "2000",
        cliente_email: "maria@example.com", payment_status: "approved", paid_at: "2026-11-03T12:00:00.000Z", payment_confirmed_amount: 45000,
        delivered_at: null, order_change_status: null, shipping_cost_real: 2500,
      })
    }
    if (call.path === "/rest/v1/order_packages") return Response.json({ parcel_count: 2 })
    return undefined
  }
}

const courierPost = (body: unknown, token = TOKEN) => new Request(`http://localhost/api/delivery/${token}`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
})
const tokenParams = (token = TOKEN) => ({ params: Promise.resolve({ token }) })

test("cadete: token con formato inválido o cuerpo inválido no llegan a la base", async () => {
  const { POST } = await import("../../app/api/delivery/[token]/route")
  await withSupabase(async (calls) => {
    assert.equal((await POST(courierPost({ action: "absent", expectedAttempts: 0 }, "corto"), tokenParams("corto"))).status, 404)
    for (const body of [
      { action: "cancelar", expectedAttempts: 0 },
      { action: "absent", expectedAttempts: 0, precio: 1 },
      { action: "absent", expectedAttempts: 3 },
      { action: "incident", expectedAttempts: 0, reason: "other", comment: " " },
      { action: "incident", expectedAttempts: 0, reason: "rejected", comment: "x".repeat(281) },
      { action: "delivered", expectedAttempts: 0, reason: "rejected" },
    ]) {
      const response = await POST(courierPost(body), tokenParams())
      assert.equal(response.status, 400, JSON.stringify(body))
    }
    assert.deepEqual(calls, [], "nada consulta la base")
  }, () => undefined)
})

test("cadete: 1.er ausente usa la RPC atómica con los intentos vistos y devuelve sólo datos mínimos", async () => {
  const { POST } = await import("../../app/api/delivery/[token]/route")
  const state: CourierState = { estado: "en_camino", outcome: "pending", failedAttempts: 0 }
  await withSupabase(async (calls) => {
    const response = await POST(courierPost({ action: "absent", expectedAttempts: 0 }), tokenParams())
    assert.equal(response.status, 200)
    assert.equal(response.headers.get("cache-control"), "no-store")
    const payload = await response.json() as { ok: boolean; message: string; view: Record<string, unknown> }
    assert.equal(payload.ok, true)
    assert.match(payload.message, /primer intento/)
    const rpc = calls.find((call) => call.path === "/rest/v1/rpc/record_local_delivery_courier_outcome")
    assert.deepEqual(rpc?.body, { p_token: TOKEN, p_outcome: "absent", p_expected_attempts: 0, p_reason: null, p_comment: null })
    assert.deepEqual(payload.view.screen, { kind: "actions", failedAttempts: 1 })
    assert.deepEqual(Object.keys(payload.view).sort(), ["address", "customerName", "failedAttempts", "locality", "orderCode", "parcels", "reference", "screen"])
    const serialized = JSON.stringify(payload).toLowerCase()
    for (const forbidden of ["maria@example.com", "45000", "2500", "approved", "payment", "dni", "cuit", '"41"', "order_id"]) {
      assert.equal(serialized.includes(forbidden), false, forbidden)
    }
    assert.ok(calls.every((call) => !/andreani/i.test(call.path)), "nada de Andreani")
  }, courierDb(state, {
    record_local_delivery_courier_outcome: () => {
      state.outcome = "first_attempt_failed"
      state.failedAttempts = 1
      return Response.json({ orderId: 41, result: "first_attempt_failed", changed: true, outcomeStatus: "first_attempt_failed", failedAttempts: 1, estado: "en_camino" })
    },
  }))
})

test("cadete: doble toque o estado ya cambiado => sin segundo resultado", async () => {
  const { POST } = await import("../../app/api/delivery/[token]/route")
  const state: CourierState = { estado: "en_camino", outcome: "first_attempt_failed", failedAttempts: 1 }
  await withSupabase(async () => {
    const response = await POST(courierPost({ action: "absent", expectedAttempts: 0 }), tokenParams())
    assert.equal(response.status, 200)
    const payload = await response.json() as { message: string }
    assert.match(payload.message, /ya estaba registrado/)
  }, courierDb(state, {
    record_local_delivery_courier_outcome: () => Response.json({ orderId: 41, result: "unchanged", changed: false, outcomeStatus: "first_attempt_failed", failedAttempts: 1, estado: "en_camino" }),
  }))
})

test("cadete: tercer 'Cliente ausente' => 409 con mensaje humano (la RPC es la fuente de verdad)", async () => {
  const { POST } = await import("../../app/api/delivery/[token]/route")
  await withSupabase(async () => {
    const response = await POST(courierPost({ action: "absent", expectedAttempts: 2 }), tokenParams())
    assert.equal(response.status, 409)
    const payload = await response.json() as { ok: boolean; message: string; view: { screen: { kind: string } } }
    assert.deepEqual([payload.ok, payload.message], [false, "El pedido ya alcanzó el máximo de intentos de entrega."])
    assert.equal(payload.view.screen.kind, "returning")
  }, courierDb({ estado: "en_camino", outcome: "returning", failedAttempts: 2 }, {
    record_local_delivery_courier_outcome: () => Response.json({ orderId: 41, result: "max_attempts", changed: false, outcomeStatus: "returning", failedAttempts: 2, estado: "en_camino" }),
  }))
})

test("cadete: Entregado pasa por la transición canónica del servicio (RPC del cadete + efectos con actor courier)", async () => {
  const { POST } = await import("../../app/api/delivery/[token]/route")
  const state: CourierState = { estado: "en_camino", outcome: "first_attempt_failed", failedAttempts: 1 }
  await withSupabase(async (calls) => {
    const response = await POST(courierPost({ action: "delivered", expectedAttempts: 1 }), tokenParams())
    assert.equal(response.status, 200)
    assert.match((await response.json() as { message: string }).message, /Entrega registrada/)
    const transition = calls.find((call) => call.path === "/rest/v1/rpc/mark_local_delivery_delivered_by_courier")
    assert.deepEqual(transition?.body, { p_token: TOKEN })
    assert.equal(calls.some((call) => call.method === "PATCH" && call.path === "/rest/v1/ordenes"), false, "nunca un UPDATE directo desde el cadete")
    const status = calls.find((call) => call.method === "POST" && call.path === "/rest/v1/order_audit_events" &&
      (call.body as { action?: string }).action === "order_status_changed")
    const row = status?.body as { actor_type: string; actor_id: string | null; new_status: string; metadata: Record<string, unknown> }
    assert.deepEqual([row.actor_type, row.actor_id, row.new_status, row.metadata.via, row.metadata.localDeliveryCost], ["courier", null, "entregado", "qr", 2500])
  }, courierDb(state, {
    mark_local_delivery_delivered_by_courier: () => {
      state.estado = "entregado"
      state.outcome = "delivered"
      return Response.json({ id: 41, estado: "entregado", shipping_provider: "beyonix", envio_proveedor: null, delivered_at: "2026-11-05T15:00:00.000Z", cancelled_at: null,
        financial_status: "payment_confirmed", order_change_status: null, paid_at: "2026-11-03T12:00:00.000Z", payment_status: "approved", payment_confirmed_amount: 45000,
        shipping_cost_real: 2500, cliente_email: "maria@example.com", cliente_nombre: "María José Peña" })
    },
  }))
})

test("cadete: Entregado sobre un pedido que vuelve a BEYONIX no escribe nada", async () => {
  const { POST } = await import("../../app/api/delivery/[token]/route")
  await withSupabase(async (calls) => {
    const response = await POST(courierPost({ action: "delivered", expectedAttempts: 2 }), tokenParams())
    assert.equal(response.status, 409)
    const payload = await response.json() as { view: { screen: { kind: string } } }
    assert.equal(payload.view.screen.kind, "returning")
    assert.equal(calls.some((call) => call.path.startsWith("/rest/v1/rpc/") || call.method !== "GET"), false)
  }, courierDb({ estado: "en_camino", outcome: "returning", failedAttempts: 2 }))
})

test("cadete: un token desconocido o revocado es 404 sin datos", async () => {
  const { POST } = await import("../../app/api/delivery/[token]/route")
  await withSupabase(async () => {
    const response = await POST(courierPost({ action: "absent", expectedAttempts: 0 }, "OtroTokenQueNoExiste12345"), tokenParams("OtroTokenQueNoExiste12345"))
    assert.equal(response.status, 404)
    assert.deepEqual(Object.keys(await response.json() as object).sort(), ["message", "ok"])
  }, courierDb({ estado: "en_camino", outcome: "pending", failedAttempts: 0 }))
})

test("recepción de devolución local: sólo operadores; usa los días de la configuración vigente", async () => {
  const { POST } = await import("../../app/api/admin/dispatch/local/returns/route")
  const request = (code: unknown) => new Request("http://localhost/api/admin/dispatch/local/returns", {
    method: "POST", headers: { Authorization: "Bearer user-token", "Content-Type": "application/json" }, body: JSON.stringify({ code }),
  })
  await withSupabase(async (calls) => {
    assert.equal((await POST(request("BX-PKG-1041-01"))).status, 403)
    assert.equal(calls.some((call) => call.path.startsWith("/rest/v1/rpc/")), false)
  }, () => undefined, "cliente")
  await withSupabase(async (calls) => {
    const response = await POST(request("BX-PKG-1041-01"))
    assert.equal(response.status, 200)
    const payload = await response.json() as { received: number; parcelCount: number; complete: boolean }
    assert.deepEqual([payload.received, payload.parcelCount, payload.complete], [1, 2, false])
    const rpc = calls.find((call) => call.path === "/rest/v1/rpc/receive_local_delivery_return_parcel")
    assert.deepEqual(rpc?.body, { p_code: "BX-PKG-1041-01", p_actor_id: "actor", p_reservation_days: 5 })
  }, (call) => {
    if (call.path === "/rest/v1/site_settings") {
      return Response.json({ value: { enabled: true, customerPrice: 2500, internalDeliveryCost: 2500, freeThreshold: 50000, postalCodes: ["2000"], returnReservationDays: 5 } })
    }
    if (call.path === "/rest/v1/rpc/receive_local_delivery_return_parcel") {
      return Response.json({ orderId: 41, code: "BX-PKG-1041-01", parcelIndex: 1, parcelCount: 2, received: 1, complete: false, completedNow: false, duplicate: false, reservationExpiresAt: null })
    }
    return undefined
  })
  await withSupabase(async () => {
    const response = await POST(request("BX-PKG-1041-01"))
    assert.equal(response.status, 409)
    assert.match((await response.json() as { error: string }).error, /BX-1041 no está regresando a BEYONIX/)
  }, (call) => call.path === "/rest/v1/site_settings" ? Response.json(null)
    : call.path === "/rest/v1/rpc/receive_local_delivery_return_parcel" ? rpcError("LOCAL_DELIVERY_RETURN_NOT_EXPECTED", "41") : undefined)
})

test("Despachos: resolver una incidencia usa la RPC con el operador; acciones desconocidas se rechazan", async () => {
  const { POST } = await import("../../app/api/admin/dispatch/local/route")
  const request = (body: unknown) => new Request("http://localhost/api/admin/dispatch/local", {
    method: "POST", headers: { Authorization: "Bearer user-token", "Content-Type": "application/json" }, body: JSON.stringify(body),
  })
  await withSupabase(async (calls) => {
    assert.equal((await POST(request({ orderId: 41, action: "incident_return" }))).status, 200)
    const rpc = calls.find((call) => call.path === "/rest/v1/rpc/resolve_local_delivery_incident")
    assert.deepEqual(rpc?.body, { p_order_id: 41, p_actor_id: "actor", p_resolution: "return" })
    assert.equal((await POST(request({ orderId: 41, action: "borrar" }))).status, 400)
  }, () => undefined)
  await withSupabase(async () => {
    const response = await POST(request({ orderId: 41, action: "incident_retry" }))
    assert.equal(response.status, 409)
    assert.match((await response.json() as { error: string }).error, /ya no tiene una incidencia abierta/)
  }, (call) => call.path === "/rest/v1/rpc/resolve_local_delivery_incident" ? rpcError("LOCAL_DELIVERY_STATE_CHANGED") : undefined)
})

test("Despachos: Entregado sobre un pedido que regresa a BEYONIX se rechaza con mensaje claro y sin escribir", async () => {
  const { POST } = await import("../../app/api/admin/dispatch/local/route")
  await withSupabase(async (calls) => {
    const response = await POST(new Request("http://localhost/api/admin/dispatch/local", {
      method: "POST", headers: { Authorization: "Bearer user-token", "Content-Type": "application/json" }, body: JSON.stringify({ orderId: 41, action: "entregado" }),
    }))
    assert.equal(response.status, 409)
    assert.match((await response.json() as { error: string }).error, /regresando o ya regresó a BEYONIX/)
    assert.equal(calls.some((call) => call.method === "PATCH"), false)
  }, (call) => call.path === "/rest/v1/local_delivery_shipments"
    ? Response.json([{ id: 7, order_id: 41, shipment_number: 1, outcome_status: "returning", failed_attempts: 2, first_attempt_failed_at: null, second_attempt_failed_at: null,
        incident_reason: null, incident_comment: null, incident_at: null, returning_at: "2026-11-05T10:00:00.000Z", returned_at: null }])
    : undefined)
})

test("job de vencimiento: sin el secreto no corre; con el secreto procesa en lotes", async () => {
  const { GET } = await import("../../app/api/cron/expire-local-delivery-reservations/route")
  let runs = 0
  await withSupabase(async (calls) => {
    assert.equal((await GET(new Request("http://localhost/api/cron/expire-local-delivery-reservations"))).status, 401)
    assert.equal(calls.length, 0)
    const response = await GET(new Request("http://localhost/api/cron/expire-local-delivery-reservations", { headers: { Authorization: "Bearer cron-secret-de-prueba" } }))
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true, expired: 103 })
    assert.equal(runs, 2, "segundo lote porque el primero vino lleno")
  }, (call) => {
    if (call.path !== "/rest/v1/rpc/expire_local_delivery_return_reservations") return undefined
    runs += 1
    return Response.json({ expired: runs === 1 ? 100 : 3, orderIds: [] })
  })
})

test("Despachos GET: el cupo se aplica por subestado en la base; 200 devueltos no ocultan un pedido nuevo", async () => {
  const { GET } = await import("../../app/api/admin/dispatch/local/route")
  const returnedIds = Array.from({ length: 200 }, (_, index) => index + 1)
  const row = (id: number, estado: string) => ({ id, estado, created_at: "2026-11-01T12:00:00Z", paid_at: "2026-11-01T12:00:00Z", delivered_at: null,
    cliente_nombre: `Cliente ${id}`, cliente_telefono: null, cliente_direccion: "Mitre 10", localidad: "Rosario", cp_destino: "2000" })
  const shipment = (orderId: number, outcome: string) => ({ id: orderId, order_id: orderId, shipment_number: 1, outcome_status: outcome, failed_attempts: outcome === "returned" ? 2 : 0,
    first_attempt_failed_at: null, second_attempt_failed_at: null, incident_reason: null, incident_comment: null, incident_at: null, returning_at: null, returned_at: null })
  await withSupabase(async (calls) => {
    const response = await GET(new Request("http://localhost/api/admin/dispatch/local", { headers: { Authorization: "Bearer user-token" } }))
    assert.equal(response.status, 200)
    const { orders } = await response.json() as { orders: Array<{ id: number; outcome: { status: string } | null; pendingEffects: string[] }> }
    // Las dos colas se piden en paralelo: el orden de las llamadas no importa.
    const queues = calls.filter((call) => call.path === "/rest/v1/rpc/local_delivery_queue_order_ids").map((call) => call.body)
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
    assert.deepEqual(queues, [{ p_queue: "operational", p_limit: 200 }, { p_queue: "returned", p_limit: 100 }])
    // La lectura de pedidos activos es por id de las colas, nunca "estado en_camino + limit".
    const read = calls.find((call) => call.path === "/rest/v1/ordenes" && call.filters.id)
    assert.ok(read?.filters.id.startsWith("in.(5001,"), read?.filters.id)
    assert.equal(calls.some((call) => call.path === "/rest/v1/ordenes" && call.filters.estado === "in.(pagado,preparado,en_camino)"), false)
    assert.deepEqual(orders.slice(0, 2).map((order) => order.id), [5001, 5002], "el nuevo y el regresando, primero")
    assert.equal(orders.filter((order) => order.outcome?.status === "returned").length, 200, "devueltos en su propia cola")
    // Aviso "En camino" pendiente de un pedido que regresa: no se ofrece reintentar (quedó obsoleto).
    assert.equal(orders.find((order) => order.id === 5002)?.pendingEffects.includes("in_transit_email"), false)
  }, (call) => {
    if (call.path === "/rest/v1/rpc/local_delivery_queue_order_ids") {
      return Response.json((call.body as { p_queue: string }).p_queue === "operational" ? [5001, 5002] : returnedIds)
    }
    if (call.path === "/rest/v1/ordenes") {
      if (call.filters.estado === "eq.entregado") return Response.json([])
      const ids = (call.filters.id ?? "").replace(/^in\.\(|\)$/g, "").split(",").map(Number)
      return Response.json(ids.map((id) => row(id, id === 5001 ? "pagado" : "en_camino")))
    }
    if (call.path === "/rest/v1/local_delivery_shipments") return Response.json([shipment(5002, "returning"), ...returnedIds.map((id) => shipment(id, "returned"))])
    if (call.path === "/rest/v1/order_packages") return Response.json([{ id: 9, order_id: 5001, status: "prepared", attempt_number: 1, parcel_count: 1 }])
    return undefined
  })
})
