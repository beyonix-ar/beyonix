import assert from "node:assert/strict"
import test, { mock } from "node:test"
import { AuthClient } from "@supabase/supabase-js"

// Despachos por proveedor: etiqueta Andreani sólo para Andreani (ni con un
// andreani_envio_id residual), etiqueta propia Envío BEYONIX por bulto y
// acciones de cada circuito separadas sobre el mismo pickeo.
type Call = { method: string; host: string; path: string; body: unknown; filters: Record<string, string> }
type Responder = (call: Call) => Response | undefined

const SUPABASE = "https://dispatch-routes.invalid"
const QR_TOKEN = "tokenDePruebaAbCdEfGhIjK"

async function withRoutes(role: string, tables: Record<string, unknown>, run: (calls: Call[]) => Promise<void>, responder?: Responder) {
  const previousEnv = { ...process.env }
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service"
  for (const key of Object.keys(process.env)) if (key.startsWith("ANDREANI_")) delete process.env[key]
  const calls: Call[] = []
  const claims = mock.method(AuthClient.prototype, "getClaims", async () => ({ data: { claims: { sub: "actor" } }, error: null }))
  const fetchMock = mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : null
    const call = { method: init?.method ?? "GET", host: url.host, path: url.pathname, body, filters: Object.fromEntries([...url.searchParams].filter(([name]) => name !== "select")) }
    calls.push(call)
    const custom = responder?.(call)
    if (custom) return custom
    if (call.path === "/rest/v1/profiles") return Response.json({ id: "actor", email: null, rol: role })
    // Token del QR de gestión de entrega (lo crea la base una sola vez por pedido).
    if (call.path === "/rest/v1/rpc/ensure_local_delivery_shipment") return Response.json(QR_TOKEN)
    if (call.method === "HEAD") return new Response(null, { status: 200, headers: { "content-range": "*/0" } })
    const table = call.path.replace("/rest/v1/", "")
    if (call.method === "GET" && table in tables) return Response.json(tables[table])
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

const post = (body: unknown) => new Request("http://localhost/api/admin/dispatch/orders/41", {
  method: "POST", headers: { Authorization: "Bearer user-token", "Content-Type": "application/json" }, body: JSON.stringify(body),
})
const params = { params: Promise.resolve({ id: "41" }) }
const order = (overrides: Record<string, unknown> = {}) => ({
  id: 41, estado: "pagado", cancelled_at: null, financial_status: "payment_confirmed", payment_status: "approved", invoice_status: "authorized",
  shipping_provider: "beyonix", envio_proveedor: null, andreani_envio_id: null, andreani_creation_status: null, andreani_tracking: null,
  andreani_creation_environment: null, andreani_handed_over_at: null, andreani_handed_over_batch_id: null, created_at: "2026-11-03T12:00:00.000Z",
  cliente_nombre: "María José Peña", cliente_direccion: "Córdoba 1234. Referencias: Portón verde", localidad: "Rosario", provincia: "Santa Fe",
  cp_destino: "2000", cliente_telefono: "341 555-0000", total: 45000, ...overrides,
})
const andreaniOrder = (overrides: Record<string, unknown> = {}) => order({ shipping_provider: "andreani", andreani_envio_id: "ENV-41", andreani_creation_status: "created", andreani_tracking: "360000000041", ...overrides })
const external = (calls: Call[]) => calls.filter((call) => !SUPABASE.endsWith(call.host))
const rpcs = (calls: Call[]) => calls.filter((call) => call.path.startsWith("/rest/v1/rpc/")).map((call) => call.path.replace("/rest/v1/rpc/", ""))

// ── Etiqueta Andreani: exige proveedor Andreani ─────────────────────────────

test("A: Andreani pasa la validación de proveedor y sigue hacia la etiqueta Andreani", async () => {
  const { POST } = await import("../../app/api/admin/dispatch/orders/[id]/andreani-label/route")
  await withRoutes("operador", { ordenes: andreaniOrder() }, async (calls) => {
    const response = await POST(post({ formato: "pdf" }), params)
    const payload = await response.json() as { error?: string }
    assert.doesNotMatch(payload.error ?? "", /no usa Andreani/, "no la frena el proveedor")
    // Sin credenciales Andreani en el test: llega a getEtiquetas y la frena la configuración.
    assert.equal(response.status, 502)
    assert.match(payload.error ?? "", /configuración de Andreani/)
    const read = calls.find((call) => call.path === "/rest/v1/ordenes")
    assert.ok(read, "lee el pedido")
  })
})

test("B y C: Envío BEYONIX (también con andreani_envio_id residual) nunca descarga etiqueta Andreani, por ninguna ruta", async () => {
  const dispatchLabel = await import("../../app/api/admin/dispatch/orders/[id]/andreani-label/route")
  const adminLabel = await import("../../app/api/andreani/etiqueta/route")
  for (const local of [order(), order({ andreani_envio_id: "ENV-RESIDUAL", andreani_creation_status: "created", andreani_tracking: "360000009999" })]) {
    await withRoutes("admin", { ordenes: local }, async (calls) => {
      const response = await dispatchLabel.POST(post({ formato: "pdf" }), params)
      assert.equal(response.status, 409)
      assert.match((await response.json()).error, /no usa Andreani/)
      const admin = await adminLabel.POST(new Request("http://localhost/api/andreani/etiqueta", { method: "POST", headers: { Authorization: "Bearer user-token", "Content-Type": "application/json" }, body: JSON.stringify({ pedidoId: 41 }) }))
      assert.equal(admin.status, 400)
      assert.match((await admin.json()).error, /no usa Andreani/)
      assert.deepEqual(external(calls), [], "nunca se contacta a Andreani")
    })
  }
})

// ── Etiqueta Envío BEYONIX ──────────────────────────────────────────────────

const preparedTables = (parcelCount: number) => ({
  ordenes: order(),
  order_packages: { id: 9, status: "prepared", attempt_number: 1, parcel_count: parcelCount, parcels_defined_at: "2026-11-03T15:30:00.000Z" },
  order_package_parcels: Array.from({ length: parcelCount }, (_, index) => ({ barcode: `BX-PKG-1041-0${index + 1}`, parcel_index: index + 1, parcel_count: parcelCount })),
})

const GENERATED_RPC = "/rest/v1/rpc/record_local_delivery_labels_generated"
const rpcError = (message: string) => Response.json({ code: "P0001", message, details: null, hint: null }, { status: 400 })

test("D: Envío BEYONIX genera una etiqueta propia por bulto y registra la GENERACIÓN (no la impresión) del intento vigente; regenerar conserva los códigos", async () => {
  const { POST } = await import("../../app/api/admin/dispatch/orders/[id]/local-label/route")
  const runs: string[][] = []
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const responder: Responder = (call) => call.path === GENERATED_RPC
      ? Response.json({ packageId: 9, attempt: 1, parcelCount: 2, reprint: attempt > 0 }) : undefined
    await withRoutes("operador", preparedTables(2), async (calls) => {
      const response = await POST(post({}), params)
      assert.equal(response.status, 200)
      const { labels } = await response.json() as { labels: Array<Record<string, unknown>> }
      assert.deepEqual(labels.map((label) => [label.kind, label.index, label.count, label.orderCode]), [["local_delivery", 1, 2, "BX-1041"], ["local_delivery", 2, 2, "BX-1041"]])
      assert.deepEqual([labels[0].recipient, labels[0].address, labels[0].reference, labels[0].postalCode, labels[0].phone], ["María José Peña", "Córdoba 1234", "Portón verde", "2000", "341 555-0000"])
      // Un único QR por pedido (mismo en cada bulto), con el token y nunca el id del pedido.
      assert.deepEqual([...new Set(labels.map((label) => label.deliveryUrl))], [`http://localhost:3000/delivery/${QR_TOKEN}`])
      const ensured = calls.find((call) => call.path === "/rest/v1/rpc/ensure_local_delivery_shipment")
      assert.equal((ensured?.body as { p_order_id?: number } | undefined)?.p_order_id, 41)
      assert.match(String((ensured?.body as { p_token?: string } | undefined)?.p_token), /^[A-Za-z0-9_-]{22}$/, "token aleatorio de 128 bits generado en el servidor")
      const serialized = JSON.stringify(labels)
      for (const forbidden of ["45000", "total", "payment", "andreani"]) assert.equal(serialized.toLowerCase().includes(forbidden), false, forbidden)
      const generated = calls.find((call) => call.path === GENERATED_RPC)
      assert.ok(generated, "registra la generación bajo lock en la base")
      assert.deepEqual(generated.body, { p_order_id: 41, p_actor_id: "actor", p_package_id: 9, p_attempt: 1, p_barcodes: ["BX-PKG-1041-01", "BX-PKG-1041-02"] })
      assert.equal(calls.some((call) => call.path === "/rest/v1/order_audit_events"), false, "sin insert directo ni evento 'printed'")
      runs.push(labels.map((label) => String(label.code)))
      assert.deepEqual(external(calls), [])
    }, responder)
  }
  assert.deepEqual(runs[1], runs[0], "regenerar = mismos BX-PKG")
})

test("D2: rearmado entre la lectura y el registro => 409 y NO se devuelven las etiquetas del intento anterior", async () => {
  const { POST } = await import("../../app/api/admin/dispatch/orders/[id]/local-label/route")
  for (const [message, status, expected] of [
    ["DISPATCH_PARCEL_STALE", 409, /preparación del pedido cambió/],
    ["LOCAL_DELIVERY_LABEL_ORDER_CANCELLED", 409, /cancelado/],
    ["unexpected failure", 500, /No se pudo registrar la generación/],
  ] as const) {
    await withRoutes("operador", preparedTables(1), async () => {
      const response = await POST(post({}), params)
      assert.equal(response.status, status, message)
      const payload = await response.json() as { labels?: unknown; error?: string }
      assert.equal(payload.labels, undefined, `${message}: sin etiquetas`)
      assert.match(payload.error ?? "", expected)
    }, (call) => call.path === GENERATED_RPC ? rpcError(message) : undefined)
  }
})

test("D3: datos de entrega que no entran legibles => 409 con mensaje claro, sin registrar ni devolver etiquetas", async () => {
  const { POST } = await import("../../app/api/admin/dispatch/orders/[id]/local-label/route")
  const huge = order({ cliente_direccion: `${"Calle muy larga con muchísimo texto ".repeat(10)}123. Referencias: ${"referencia extensa ".repeat(16)}` })
  await withRoutes("operador", { ...preparedTables(1), ordenes: huge }, async (calls) => {
    const response = await POST(post({}), params)
    assert.equal(response.status, 409)
    assert.equal((await response.json()).error, "Los datos de entrega son demasiado largos para esta etiqueta. Revisalos antes de imprimir.")
    assert.equal(calls.some((call) => call.path === GENERATED_RPC), false)
  })
})

test("E: Andreani no usa la etiqueta BEYONIX; sin bultos definidos tampoco se imprime", async () => {
  const { POST } = await import("../../app/api/admin/dispatch/orders/[id]/local-label/route")
  await withRoutes("operador", { ...preparedTables(1), ordenes: andreaniOrder() }, async (calls) => {
    const response = await POST(post({}), params)
    assert.equal(response.status, 409)
    assert.match((await response.json()).error, /no usa Envío BEYONIX/)
    assert.equal(calls.some((call) => call.path === GENERATED_RPC || call.path === "/rest/v1/order_audit_events"), false)
  })
  await withRoutes("operador", { ...preparedTables(1), order_packages: { id: 9, status: "prepared", attempt_number: 1, parcel_count: null, parcels_defined_at: null } }, async () => {
    assert.equal((await POST(post({}), params)).status, 409)
  })
})

test("seguridad: sin sesión interna no hay etiquetas (no existe endpoint público)", async () => {
  const { POST } = await import("../../app/api/admin/dispatch/orders/[id]/local-label/route")
  await withRoutes("cliente", preparedTables(1), async (calls) => {
    assert.equal((await POST(post({}), params)).status, 403)
    assert.ok(calls.every((call) => call.path === "/rest/v1/profiles"))
  })
})

// ── Acciones del pedido en Despachos ────────────────────────────────────────

test("Envío BEYONIX: no genera envío ni confirma etiqueta Andreani (ni un Super Admin)", async () => {
  const { POST } = await import("../../app/api/admin/dispatch/orders/[id]/route")
  for (const local of [order(), order({ andreani_envio_id: "ENV-RESIDUAL", andreani_creation_status: "created" })]) {
    await withRoutes("super_admin", { ordenes: local }, async (calls) => {
      const ship = await POST(post({ action: "ship", requestKey: "11111111-1111-4111-8111-111111111111" }), params)
      assert.equal(ship.status, 409)
      assert.match((await ship.json()).error, /no lleva envío ni etiqueta Andreani/)
      const label = await POST(post({ action: "confirm_label", code: "360000009999" }), params)
      assert.equal(label.status, 409)
      assert.deepEqual(rpcs(calls), [])
      assert.deepEqual(external(calls), [])
    })
  }
})

test("Andreani: no define bultos ni confirma etiquetas BEYONIX", async () => {
  const { POST } = await import("../../app/api/admin/dispatch/orders/[id]/route")
  await withRoutes("admin", { ordenes: andreaniOrder() }, async (calls) => {
    assert.equal((await POST(post({ action: "local_parcels", parcelCount: 2, requestKey: "11111111-1111-4111-8111-111111111111" }), params)).status, 409)
    assert.equal((await POST(post({ action: "confirm_parcel", code: "BX-PKG-1041-01" }), params)).status, 409)
    assert.deepEqual(rpcs(calls), [])
  })
})

test("Envío BEYONIX: mismo pickeo (start/scan) y bultos/confirmación propios contra las RPC de la base", async () => {
  const { POST } = await import("../../app/api/admin/dispatch/orders/[id]/route")
  const responder: Responder = (call) => call.path === "/rest/v1/rpc/confirm_local_delivery_parcel"
    ? Response.json({ orderId: 41, code: "BX-PKG-1041-01", parcelIndex: 1, parcelCount: 2, confirmed: 1, complete: false, duplicate: false }) : undefined
  await withRoutes("operador", { ordenes: order() }, async (calls) => {
    assert.equal((await POST(post({ action: "start" }), params)).status, 200)
    assert.equal((await POST(post({ action: "scan", code: "SKU-A", requestKey: "22222222-2222-4222-8222-222222222222" }), params)).status, 200)
    assert.equal((await POST(post({ action: "local_parcels", parcelCount: 0, requestKey: "33333333-3333-4333-8333-333333333333" }), params)).status, 400)
    assert.equal((await POST(post({ action: "local_parcels", parcelCount: 2, requestKey: "33333333-3333-4333-8333-333333333333" }), params)).status, 200)
    const confirmed = await POST(post({ action: "confirm_parcel", code: "BX-PKG-1041-01" }), params)
    assert.equal(confirmed.status, 200)
    assert.equal((await confirmed.json()).parcelConfirmation.parcelIndex, 1)
    assert.deepEqual(rpcs(calls), ["begin_order_preparation", "scan_order_preparation_code", "set_order_package_parcels", "confirm_local_delivery_parcel"])
    const parcels = calls.find((call) => call.path === "/rest/v1/rpc/set_order_package_parcels")?.body as Record<string, unknown>
    assert.deepEqual([parcels.p_order_id, parcels.p_parcel_count], [41, 2])
    assert.deepEqual(external(calls), [])
  }, responder)
})

test("Envío BEYONIX ya En camino: no se rearma", async () => {
  const { POST } = await import("../../app/api/admin/dispatch/orders/[id]/route")
  await withRoutes("operador", { ordenes: order({ estado: "en_camino" }) }, async (calls) => {
    const response = await POST(post({ action: "reset", reason: "Rearmado tardío del pedido", requestKey: "44444444-4444-4444-8444-444444444444" }), params)
    assert.equal(response.status, 409)
    assert.deepEqual(rpcs(calls), [])
  })
})
