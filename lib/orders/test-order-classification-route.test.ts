import assert from "node:assert/strict"
import test, { mock } from "node:test"
import { AuthClient } from "@supabase/supabase-js"

// Ruta /api/admin/orders/[id]/test-classification: sólo super_admin, valida
// motivo/confirmación/elección antes de tocar la base y traduce los errores de
// la RPC sin exponer detalles técnicos.
type Call = { path: string; body: Record<string, unknown> | null }

async function withRoute(role: string | null, run: (calls: Call[], responders: Map<string, (body: Record<string, unknown> | null) => Response>) => Promise<void>) {
  const previousEnv = { ...process.env }
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test-orders.invalid"
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service"
  const calls: Call[] = []
  const responders = new Map<string, (body: Record<string, unknown> | null) => Response>()
  const claims = mock.method(AuthClient.prototype, "getClaims", async () => (
    role === null ? { data: null, error: new Error("invalid") } : { data: { claims: { sub: "actor-id" } }, error: null }))
  const fetchMock = mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null
    calls.push({ path: url.pathname, body })
    if (url.pathname === "/rest/v1/profiles") return Response.json({ id: "actor-id", email: null, rol: role })
    const responder = responders.get(url.pathname)
    if (responder) return responder(body)
    return Response.json([])
  })
  const errors = mock.method(console, "error", () => {})
  try {
    await run(calls, responders)
  } finally {
    claims.mock.restore(); fetchMock.mock.restore(); errors.mock.restore()
    for (const key of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"]) {
      if (previousEnv[key] === undefined) delete process.env[key]; else process.env[key] = previousEnv[key]
    }
  }
}

const params = (id: string) => ({ params: Promise.resolve({ id }) })
const post = (body: unknown, token: string | null = "user-token") => new Request("http://localhost/api/admin/orders/19/test-classification", {
  method: "POST",
  headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body),
})
const get = () => new Request("http://localhost/api/admin/orders/19/test-classification", { headers: { Authorization: "Bearer user-token" } })
const VALID = { reason: "Compra de prueba del propietario, conserva el producto", confirmation: "bx-1019", restock: true }

test("permisos: anon 401; cliente, operador y admin 403 sin tocar datos", async () => {
  const route = await import("../../app/api/admin/orders/[id]/test-classification/route")
  await withRoute(null, async (calls) => {
    assert.equal((await route.POST(post(VALID), params("19"))).status, 401)
    assert.equal(calls.filter((call) => call.path.startsWith("/rest/v1/rpc")).length, 0)
  })
  for (const role of ["cliente", "operador", "admin"]) {
    await withRoute(role, async (calls) => {
      assert.equal((await route.POST(post(VALID), params("19"))).status, 403, role)
      assert.equal((await route.GET(get(), params("19"))).status, 403, role)
      assert.ok(calls.every((call) => call.path === "/rest/v1/profiles"), `${role}: un rechazo nunca toca datos`)
    })
  }
})

test("super_admin: valida antes de la RPC y envía el actor autenticado, nunca uno del cliente", async () => {
  const route = await import("../../app/api/admin/orders/[id]/test-classification/route")
  await withRoute("super_admin", async (calls, responders) => {
    assert.equal((await route.POST(post({ ...VALID, reason: "corto" }), params("19"))).status, 400)
    assert.equal((await route.POST(post({ ...VALID, confirmation: "BX-1020" }), params("19"))).status, 400)
    assert.equal((await route.POST(post({ ...VALID, restock: "sí" }), params("19"))).status, 400)
    assert.equal((await route.POST(post("{"), params("19"))).status, 400)
    assert.equal((await route.POST(post(VALID), params("abc"))).status, 400)
    assert.equal(calls.filter((call) => call.path.startsWith("/rest/v1/rpc")).length, 0, "nada inválido llega a la base")

    responders.set("/rest/v1/rpc/classify_test_order_admin", () => Response.json({ id: 19, alreadyClassified: false, restocked: [{ orderItemId: 26, quantity: 1 }] }))
    const response = await route.POST(post({ ...VALID, actor: "otro-usuario" }), params("19"))
    assert.equal(response.status, 200)
    const rpc = calls.find((call) => call.path === "/rest/v1/rpc/classify_test_order_admin")
    assert.deepEqual(rpc?.body, {
      p_order_id: 19,
      p_actor: "actor-id",
      p_reason: VALID.reason,
      p_confirmation: "bx-1019",
      p_restock: true,
    })
  })
})

test("errores de la RPC: bloqueos legibles (409) y nada técnico al usuario", async () => {
  const route = await import("../../app/api/admin/orders/[id]/test-classification/route")
  await withRoute("super_admin", async (_calls, responders) => {
    responders.set("/rest/v1/rpc/classify_test_order_admin", () => Response.json(
      { code: "P0001", message: "ORDER_TEST_BLOCKED:buyer_not_internal,open_claim", details: null, hint: null }, { status: 400 }))
    const blocked = await route.POST(post(VALID), params("19"))
    assert.equal(blocked.status, 409)
    const body = await blocked.json() as { reasons: string[]; blockers: string[] }
    assert.deepEqual(body.blockers, ["buyer_not_internal", "open_claim"])
    assert.equal(body.reasons[1], "Hay un reclamo abierto.")

    responders.set("/rest/v1/rpc/classify_test_order_admin", () => Response.json(
      { code: "XX000", message: "relation secreta does not exist", details: null, hint: null }, { status: 400 }))
    const unknown = await route.POST(post(VALID), params("19"))
    assert.equal(unknown.status, 500)
    assert.deepEqual(await unknown.json(), { error: "No se pudo clasificar el pedido como prueba." })
  })
})

test("vista previa: bloqueos, plan validado y texto de confirmación", async () => {
  const route = await import("../../app/api/admin/orders/[id]/test-classification/route")
  await withRoute("super_admin", async (_calls, responders) => {
    responders.set("/rest/v1/rpc/order_test_classification_blockers", () => Response.json([]))
    responders.set("/rest/v1/rpc/order_test_restock_plan", () => Response.json([
      { orderItemId: 26, productId: 22, variantId: 22, productName: "AURICULAR ÑANDÚ", variantName: "Negro", quantity: 1, consumed: 1, returned: 0, released: 0, compensated: 0, pending: 1, supported: true },
    ]))
    const response = await route.GET(get(), params("19"))
    assert.equal(response.status, 200)
    const body = await response.json() as { confirmation: string; blockers: string[]; restockPlan: Array<{ pending: number }> }
    assert.equal(body.confirmation, "BX-1019")
    assert.deepEqual(body.blockers, [])
    assert.equal(body.restockPlan[0].pending, 1)

    responders.set("/rest/v1/rpc/order_test_restock_plan", () => Response.json([{ orderItemId: "x" }]))
    assert.equal((await route.GET(get(), params("19"))).status, 500, "un plan inválido nunca se muestra")
  })
})

test("archivo: la base rechaza ocultar compras reales y restaurar pruebas; la ruta lo explica (409)", async () => {
  const route = await import("../../app/api/admin/orders/[id]/archive/route")
  const archiveRequest = (method: string, body: unknown) => new Request("http://localhost/api/admin/orders/21/archive", {
    method, headers: { Authorization: "Bearer user-token", "Content-Type": "application/json" }, body: JSON.stringify(body),
  })
  await withRoute("super_admin", async (calls, responders) => {
    responders.set("/rest/v1/rpc/archive_order_admin", () => Response.json(
      { code: "P0001", message: "ORDER_ARCHIVE_HIDE_REQUIRES_TEST", details: null, hint: null }, { status: 400 }))
    const hidden = await route.POST(archiveRequest("POST", { reason: "Compra real de un cliente", hideFromCustomer: true }), params("21"))
    assert.equal(hidden.status, 409)
    assert.deepEqual(await hidden.json(), { error: "Sólo una compra de prueba clasificada puede ocultarse de la cuenta del cliente." })
    assert.equal(calls.find((call) => call.path === "/rest/v1/rpc/archive_order_admin")?.body?.p_hide_from_customer, true, "la decisión la toma la base")

    responders.set("/rest/v1/rpc/unarchive_order_admin", () => Response.json(
      { code: "P0001", message: "ORDER_TEST_ARCHIVE_LOCKED", details: null, hint: null }, { status: 400 }))
    const restore = await route.DELETE(archiveRequest("DELETE", { reason: "Volver al listado" }), params("19"))
    assert.equal(restore.status, 409)
    assert.deepEqual(await restore.json(), { error: "Una compra de prueba queda archivada y no vuelve al listado operativo." })
  })
})
