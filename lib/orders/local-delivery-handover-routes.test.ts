import assert from "node:assert/strict"
import test, { mock } from "node:test"
import { AuthClient } from "@supabase/supabase-js"

// Envío BEYONIX ya entregado al cadete: reimpresión de etiquetas (Admin),
// acceso al QR del cadete desde Despachos y corrección de "Entregado al
// cadete". Ninguna de estas rutas crea envíos, bultos, tokens ni cambia stock.
type Call = { method: string; path: string; body: unknown; filters: Record<string, string> }
type Responder = (call: Call) => Response | undefined

const SUPABASE = "https://handover-routes.invalid"
const QR_TOKEN = "tokenDePruebaAbCdEfGhIjK"
const REQUEST_KEY = "55555555-5555-4555-8555-555555555555"
const REASON = "Se marcó por error, el pedido sigue en el depósito."

async function withRoutes(role: string, tables: Record<string, unknown>, run: (calls: Call[]) => Promise<void>, responder?: Responder) {
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
    const custom = responder?.(call)
    if (custom) return custom
    if (call.path === "/rest/v1/profiles") return Response.json({ id: "actor", email: null, rol: role })
    if (call.path === "/rest/v1/rpc/ensure_local_delivery_shipment") return Response.json(QR_TOKEN)
    if (call.path === "/rest/v1/rpc/record_local_delivery_labels_generated") return Response.json({ packageId: 9, attempt: 1, parcelCount: 2, reprint: true })
    if (call.path === "/rest/v1/rpc/local_delivery_queue_order_ids") return Response.json([])
    const table = call.path.replace("/rest/v1/", "")
    if (call.method === "GET" && table in tables) return Response.json(tables[table])
    if (call.method === "POST" && call.path === "/rest/v1/order_audit_events") return new Response(null, { status: 201 })
    return Response.json([])
  })
  try {
    await run(calls)
  } finally {
    claims.mock.restore(); fetchMock.mock.restore()
    for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key]
    Object.assign(process.env, previousEnv)
  }
}

const request = (path: string, body?: unknown) => new Request(`http://localhost/api/admin/dispatch${path}`, {
  method: body === undefined ? "GET" : "POST",
  headers: { Authorization: "Bearer user-token", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
  body: body === undefined ? undefined : JSON.stringify(body),
})
const params = { params: Promise.resolve({ id: "41" }) }
const order = (overrides: Record<string, unknown> = {}) => ({
  id: 41, estado: "en_camino", cancelled_at: null, financial_status: "payment_confirmed", shipping_provider: "beyonix", envio_proveedor: null,
  cliente_nombre: "María José Peña", cliente_direccion: "Córdoba 1234. Referencias: Portón verde", localidad: "Rosario", provincia: "Santa Fe",
  cp_destino: "2000", cliente_telefono: "341 555-0000", ...overrides,
})
const labelTables = (overrides: Record<string, unknown> = {}) => ({
  ordenes: order(overrides),
  order_packages: { id: 9, status: "prepared", attempt_number: 1, parcel_count: 2, parcels_defined_at: "2026-11-03T15:30:00.000Z" },
  order_package_parcels: [1, 2].map((index) => ({ barcode: `BX-PKG-1041-0${index}`, parcel_index: index, parcel_count: 2 })),
})
const rpcs = (calls: Call[]) => calls.filter((call) => call.path.startsWith("/rest/v1/rpc/")).map((call) => call.path.replace("/rest/v1/rpc/", ""))
/** Escrituras directas a tablas (nunca deberían existir fuera del historial). */
const writes = (calls: Call[]) => calls.filter((call) => ["POST", "PATCH", "PUT", "DELETE"].includes(call.method) && !call.path.startsWith("/rest/v1/rpc/"))
  .map((call) => `${call.method} ${call.path}`)
const rpcError = (message: string) => Response.json({ code: "P0001", message, details: null, hint: null }, { status: 400 })

// ── Reimpresión de etiquetas BEYONIX ────────────────────────────────────────

test("reimpresión En camino (Admin y Super Admin): mismos BX-PKG y mismo QR, sin crear envío, bultos ni cambiar estado", async () => {
  const { POST } = await import("../../app/api/admin/dispatch/orders/[id]/local-label/route")
  for (const role of ["admin", "super_admin"]) {
    await withRoutes(role, labelTables(), async (calls) => {
      const response = await POST(request("/orders/41/local-label", {}), params)
      assert.equal(response.status, 200, role)
      const { labels } = await response.json() as { labels: Array<{ code: string; deliveryUrl: string }> }
      assert.deepEqual(labels.map((label) => label.code), ["BX-PKG-1041-01", "BX-PKG-1041-02"])
      assert.deepEqual([...new Set(labels.map((label) => label.deliveryUrl))], [`http://localhost:3000/delivery/${QR_TOKEN}`])
      assert.deepEqual(rpcs(calls), ["ensure_local_delivery_shipment", "record_local_delivery_labels_generated"], "sólo lee el token vigente y registra la generación")
      assert.deepEqual(writes(calls), [], "sin escrituras directas: ni estado, ni bultos, ni stock")
    })
  }
})

test("reimpresión Entregado al cadete: un operador no puede (excepción de Admin); en preparación sí", async () => {
  const { POST } = await import("../../app/api/admin/dispatch/orders/[id]/local-label/route")
  for (const estado of ["en_camino", "entregado"]) {
    await withRoutes("operador", labelTables({ estado }), async (calls) => {
      const response = await POST(request("/orders/41/local-label", {}), params)
      assert.equal(response.status, 403, estado)
      assert.match((await response.json()).error, /sólo un Admin puede reimprimir/)
      assert.deepEqual(rpcs(calls), [])
    })
  }
  await withRoutes("operador", labelTables({ estado: "pagado" }), async () => {
    assert.equal((await POST(request("/orders/41/local-label", {}), params)).status, 200)
  })
})

test("reimpresión: cancelado o Andreani siguen rechazados (ni un Admin)", async () => {
  const { POST } = await import("../../app/api/admin/dispatch/orders/[id]/local-label/route")
  for (const overrides of [{ estado: "cancelado", cancelled_at: "2026-11-05T10:00:00.000Z" }, { shipping_provider: "andreani" }]) {
    await withRoutes("super_admin", labelTables(overrides), async (calls) => {
      assert.equal((await POST(request("/orders/41/local-label", {}), params)).status, 409)
      assert.deepEqual(rpcs(calls), [])
    })
  }
})

// ── QR del cadete en Despachos ──────────────────────────────────────────────

const shipment = (overrides: Record<string, unknown> = {}) => ({ id: 7, access_token: QR_TOKEN, token_revoked_at: null, outcome_status: "pending", failed_attempts: 0, ...overrides })

test("QR del cadete: devuelve el QR vigente (sin crearlo ni rotarlo) y deja la consulta en el historial", async () => {
  const { POST } = await import("../../app/api/admin/dispatch/orders/[id]/courier-qr/route")
  for (const role of ["operador", "admin"]) {
    await withRoutes(role, { ordenes: order(), local_delivery_shipments: shipment() }, async (calls) => {
      const response = await POST(request("/orders/41/courier-qr", {}), params)
      assert.equal(response.status, 200, role)
      const payload = await response.json() as { url: string; courierCanAct: boolean; orderCode: string }
      assert.equal(payload.url, `http://localhost:3000/delivery/${QR_TOKEN}`)
      assert.equal(payload.courierCanAct, true)
      assert.equal(payload.orderCode, "BX-1041")
      assert.deepEqual(rpcs(calls), [], "nunca emite ni rota tokens")
      assert.deepEqual(writes(calls), ["POST /rest/v1/order_audit_events"])
      assert.equal((calls.find((call) => call.path === "/rest/v1/order_audit_events")?.body as { action?: string }).action, "local_delivery_courier_qr_viewed")
    })
  }
  // En preparación el QR existe, pero el cadete todavía no puede registrar nada.
  await withRoutes("admin", { ordenes: order({ estado: "pagado" }), local_delivery_shipments: shipment() }, async () => {
    const payload = await (await POST(request("/orders/41/courier-qr", {}), params)).json() as { courierCanAct: boolean; screen: string }
    assert.deepEqual([payload.courierCanAct, payload.screen], [false, "preparing"])
  })
})

test("QR del cadete: sin etiquetas, revocado, cancelado o Andreani => sin QR utilizable; sin sesión interna => 403", async () => {
  const { POST } = await import("../../app/api/admin/dispatch/orders/[id]/courier-qr/route")
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ ordenes: order(), local_delivery_shipments: null }, /al imprimir las etiquetas/],
    [{ ordenes: order(), local_delivery_shipments: shipment({ token_revoked_at: "2026-11-05T10:00:00.000Z" }) }, /revocado/],
    [{ ordenes: order({ estado: "cancelado", cancelled_at: "2026-11-05T10:00:00.000Z" }), local_delivery_shipments: shipment() }, /cancelado/],
    [{ ordenes: order({ shipping_provider: "andreani" }), local_delivery_shipments: shipment() }, /no usa Envío BEYONIX/],
  ]
  for (const [tables, expected] of cases) {
    await withRoutes("admin", tables, async (calls) => {
      const response = await POST(request("/orders/41/courier-qr", {}), params)
      assert.equal(response.status, 409)
      const payload = await response.json() as { url?: string; error: string }
      assert.equal(payload.url, undefined)
      assert.match(payload.error, expected)
      assert.deepEqual(rpcs(calls), [])
      assert.deepEqual(writes(calls), [])
    })
  }
  await withRoutes("cliente", { ordenes: order(), local_delivery_shipments: shipment() }, async (calls) => {
    assert.equal((await POST(request("/orders/41/courier-qr", {}), params)).status, 403)
    assert.ok(calls.every((call) => call.path === "/rest/v1/profiles"))
  })
})

// ── Corrección de "Entregado al cadete" ─────────────────────────────────────

const REVERT_RPC = "/rest/v1/rpc/revert_local_delivery_in_transit"

test("corrección: Admin y Super Admin la ejecutan en la base con motivo y clave; un operador no", async () => {
  const { POST } = await import("../../app/api/admin/dispatch/local/route")
  for (const role of ["admin", "super_admin"]) {
    await withRoutes(role, {}, async (calls) => {
      const response = await POST(request("/local", { orderId: 41, action: "revert_in_transit", reason: `  ${REASON}  `, requestKey: REQUEST_KEY }))
      assert.equal(response.status, 200, role)
      assert.deepEqual(await response.json(), { ok: true, order: { id: 41, estado: "pagado", stage: "preparing" } })
      assert.deepEqual(rpcs(calls), ["revert_local_delivery_in_transit"])
      assert.deepEqual(calls.find((call) => call.path === REVERT_RPC)?.body, { p_order_id: 41, p_actor_id: "actor", p_reason: REASON, p_request_key: REQUEST_KEY })
      assert.deepEqual(writes(calls), [], "sin escrituras fuera de la RPC (ni pagos, ni facturas, ni stock)")
    }, (call) => call.path === REVERT_RPC ? Response.json({ orderId: 41, estado: "pagado", replayed: false }) : undefined)
  }
  for (const role of ["operador", "cliente"]) {
    await withRoutes(role, {}, async (calls) => {
      const response = await POST(request("/local", { orderId: 41, action: "revert_in_transit", reason: REASON, requestKey: REQUEST_KEY }))
      assert.equal(response.status, 403, role)
      assert.deepEqual(rpcs(calls), [])
    })
  }
})

test("corrección: motivo y clave obligatorios antes de tocar la base", async () => {
  const { POST } = await import("../../app/api/admin/dispatch/local/route")
  for (const body of [{ reason: "corto", requestKey: REQUEST_KEY }, { reason: "x".repeat(501), requestKey: REQUEST_KEY }, { reason: REASON, requestKey: "no-uuid" }, { reason: REASON }]) {
    await withRoutes("admin", {}, async (calls) => {
      assert.equal((await POST(request("/local", { orderId: 41, action: "revert_in_transit", ...body }))).status, 400)
      assert.deepEqual(rpcs(calls), [])
    })
  }
})

test("corrección rechazada por la base: mensajes claros, sin detalles técnicos", async () => {
  const { POST } = await import("../../app/api/admin/dispatch/local/route")
  const cases: Array<[string, number, RegExp]> = [
    ["LOCAL_DELIVERY_REVERT_OUTCOME_RECORDED", 409, /cadete ya registró un resultado/],
    ["LOCAL_DELIVERY_REVERT_ALREADY_DELIVERED", 409, /ya figura como entregado/],
    ["LOCAL_DELIVERY_REVERT_NOT_IN_TRANSIT", 409, /ya no está En camino/],
    ["LOCAL_DELIVERY_REVERT_ORDER_CANCELLED", 409, /cancelado o con reintegro/],
    ["LOCAL_DELIVERY_REVERT_PREVIOUS_UNKNOWN", 409, /No hay un registro confiable del estado del que salió/],
    ["LOCAL_DELIVERY_REVERT_FORBIDDEN", 403, /Sólo un Admin o Super Admin/],
    ["DISPATCH_LOCAL_DELIVERY_ONLY", 409, /no usa Envío BEYONIX/],
    ["unexpected failure", 500, /No se pudo corregir la entrega al cadete/],
  ]
  for (const [message, status, expected] of cases) {
    await withRoutes("admin", {}, async () => {
      const response = await POST(request("/local", { orderId: 41, action: "revert_in_transit", reason: REASON, requestKey: REQUEST_KEY }))
      assert.equal(response.status, status, message)
      const payload = await response.json() as { error: string }
      assert.match(payload.error, expected)
      assert.doesNotMatch(payload.error, /LOCAL_DELIVERY_|DISPATCH_/)
    }, (call) => call.path === REVERT_RPC ? rpcError(message) : undefined)
  }
})

test("Entregas locales informa quién puede corregir (la ruta y la base lo revalidan)", async () => {
  const { GET } = await import("../../app/api/admin/dispatch/local/route")
  for (const [role, expected] of [["operador", false], ["admin", true], ["super_admin", true]] as const) {
    await withRoutes(role, { ordenes: [] }, async () => {
      const response = await GET(request("/local"))
      assert.equal(response.status, 200)
      assert.deepEqual((await response.json() as { viewer: unknown }).viewer, { canRevertHandover: expected })
    })
  }
})

test("Entregas locales: 'Corregir entrega al cadete' sólo donde la base la aceptaría (incidencia reintentada => no)", async () => {
  const { GET } = await import("../../app/api/admin/dispatch/local/route")
  const BLOCKERS_RPC = "/rest/v1/rpc/local_delivery_revert_blockers"
  const rows = [41, 42].map((id) => ({ id, estado: "en_camino", created_at: "2026-11-03T12:00:00.000Z", paid_at: "2026-11-03T12:05:00.000Z", delivered_at: null,
    cliente_nombre: "María José Peña", cliente_telefono: null, cliente_direccion: "Córdoba 1234", localidad: "Rosario", cp_destino: "2000" }))
  const responder = (blockers: Response) => (call: Call) => {
    if (call.path === "/rest/v1/rpc/local_delivery_queue_order_ids") return Response.json((call.body as { p_queue: string }).p_queue === "operational" ? [41, 42] : [])
    if (call.path === "/rest/v1/ordenes") return Response.json(call.filters.estado === "eq.entregado" ? [] : rows)
    if (call.path === BLOCKERS_RPC) return blockers
    return undefined
  }
  const flags = async (response: Response) => Object.fromEntries((await response.json() as { orders: Array<{ id: number; canRevertHandover: boolean }> }).orders.map((row) => [row.id, row.canRevertHandover]))
  const blockers = () => Response.json([{ order_id: 41, blocker: null, previous_estado: "pagado" }, { order_id: 42, blocker: "LOCAL_DELIVERY_REVERT_OUTCOME_RECORDED", previous_estado: null }])

  await withRoutes("admin", {}, async (calls) => {
    const response = await GET(request("/local"))
    assert.equal(response.status, 200)
    assert.deepEqual(await flags(response), { 41: true, 42: false })
    assert.deepEqual(calls.find((call) => call.path === BLOCKERS_RPC)?.body, { p_order_ids: [41, 42] })
  }, responder(blockers()))
  // Operador: ni se consulta (nunca la ve).
  await withRoutes("operador", {}, async (calls) => {
    assert.deepEqual(await flags(await GET(request("/local"))), { 41: false, 42: false })
    assert.equal(calls.some((call) => call.path === BLOCKERS_RPC), false)
  }, responder(blockers()))
  // Si la regla no se pudo leer, no se ofrece nada (el resto de la lista sigue).
  await withRoutes("admin", {}, async () => {
    const response = await GET(request("/local"))
    assert.equal(response.status, 200)
    assert.deepEqual(await flags(response), { 41: false, 42: false })
  }, responder(rpcError("boom")))
})

// ── "¡Llega hoy!": hora de salida vigente ───────────────────────────────────

test("hora de salida para '¡Llega hoy!': sólo el registro atómico vigente; corrección o resultado del cadete posterior la anulan", async () => {
  const { loadLocalDeliveryInTransitAt } = await import("./local-delivery-outcomes-server")
  type AuditRow = { id: number; order_id: number; action: string; created_at: string }
  const fakeAdmin = (rows: AuditRow[]) => ({
    from: () => ({ select: () => ({ in: (_column: string, orderIds: number[]) => ({ in: async (_action: string, actions: string[]) => ({
      data: rows.filter((row) => orderIds.includes(row.order_id) && actions.includes(row.action)), error: null,
    }) }) }) }),
  }) as unknown as Parameters<typeof loadLocalDeliveryInTransitAt>[0]
  const marked = (id: number, orderId: number, at: string) => ({ id, order_id: orderId, action: "local_delivery_in_transit_marked", created_at: at })
  const rows: AuditRow[] = [
    // 1: salida vigente (el registro del servicio, escrito después por un reintento, no cuenta).
    marked(1, 1, "2026-11-04T12:00:00Z"),
    { id: 2, order_id: 1, action: "order_status_changed", created_at: "2026-11-05T09:00:00Z" },
    // 2: salió y Admin corrigió la entrega al cadete.
    marked(3, 2, "2026-11-04T12:00:00Z"), { id: 4, order_id: 2, action: "local_delivery_in_transit_reverted", created_at: "2026-11-04T12:10:00Z" },
    // 3: corrección y nueva salida: vale la nueva.
    marked(5, 3, "2026-11-04T12:00:00Z"), { id: 6, order_id: 3, action: "local_delivery_in_transit_reverted", created_at: "2026-11-04T12:10:00Z" }, marked(7, 3, "2026-11-04T15:00:00Z"),
    // 4: incidencia (aunque después se reintente): ya no se promete.
    marked(8, 4, "2026-11-04T12:00:00Z"), { id: 9, order_id: 4, action: "local_delivery_incident_reported", created_at: "2026-11-04T13:00:00Z" },
    { id: 10, order_id: 4, action: "local_delivery_incident_resolved", created_at: "2026-11-04T13:30:00Z" },
    // 5: salió antes de esta versión (sin registro atómico): sin promesa.
    { id: 11, order_id: 5, action: "order_status_changed", created_at: "2026-11-04T12:00:00Z" },
  ]
  const result = await loadLocalDeliveryInTransitAt(fakeAdmin(rows), [1, 2, 3, 4, 5])
  assert.deepEqual(Object.fromEntries(result), { 1: "2026-11-04T12:00:00Z", 3: "2026-11-04T15:00:00Z" })
})
