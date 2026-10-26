import assert from "node:assert/strict"
import test, { mock } from "node:test"
import { AuthClient } from "@supabase/supabase-js"

// Rutas de Analítica con Supabase simulado a nivel HTTP: el beacon público
// `product_view` y la consulta de Admin > Analítica.

type Call = { path: string; body: Record<string, unknown> | null }

const SESSION = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b"
const BROWSER_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148 Safari"

async function withSupabase(
  options: { userId: string | null; role?: string | null; rpc?: (path: string, body: Record<string, unknown> | null) => Response },
  run: (calls: Call[]) => Promise<void>,
) {
  const previousEnv = { ...process.env }
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://analytics.invalid"
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key-with-enough-length"
  const calls: Call[] = []
  const claims = mock.method(AuthClient.prototype, "getClaims", async () => (
    options.userId === null ? { data: null, error: new Error("invalid") } : { data: { claims: { sub: options.userId } }, error: null }))
  const fetchMock = mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null
    calls.push({ path: url.pathname, body })
    if (url.pathname === "/rest/v1/profiles") {
      return Response.json(options.role === undefined || options.role === null ? null : { id: options.userId, email: null, rol: options.role })
    }
    if (url.pathname.startsWith("/rest/v1/rpc/")) return options.rpc?.(url.pathname, body) ?? Response.json("recorded")
    return Response.json([])
  })
  try {
    await run(calls)
  } finally {
    claims.mock.restore(); fetchMock.mock.restore()
    for (const key of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"]) {
      if (previousEnv[key] === undefined) delete process.env[key]; else process.env[key] = previousEnv[key]
    }
  }
}

function viewRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/analytics/product-view", {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": BROWSER_UA, "X-Real-IP": "203.0.113.9", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

const recordCalls = (calls: Call[]) => calls.filter((call) => call.path === "/rest/v1/rpc/record_product_view")

test("product_view anónimo: registra sesión, producto, origen y dispositivo; nunca el IP", async () => {
  const route = await import("../../app/api/analytics/product-view/route")
  await withSupabase({ userId: null }, async (calls) => {
    const response = await route.POST(viewRequest({ sessionId: SESSION, productId: 7, source: "product_page" }))
    assert.equal(response.status, 204)
    const [call] = recordCalls(calls)
    assert.ok(call)
    assert.equal(call.body?.p_session_id, SESSION)
    assert.equal(call.body?.p_product_id, 7)
    assert.equal(call.body?.p_user_id, null)
    assert.equal(call.body?.p_source, "product_page")
    assert.equal(call.body?.p_device_type, "mobile")
    assert.match(String(call.body?.p_client_key), /^[0-9a-f]{32}$/)
    assert.ok(!JSON.stringify(calls).includes("203.0.113.9"), "el IP no sale del servidor")
  })
})

test("product_view logueado: el usuario sale del token, nunca del payload", async () => {
  const route = await import("../../app/api/analytics/product-view/route")
  await withSupabase({ userId: "cliente-real", role: "cliente" }, async (calls) => {
    await route.POST(viewRequest(
      { sessionId: SESSION, productId: 7, source: "quick_view", userId: "otro-usuario", email: "persona@correo.com" },
      { Authorization: "Bearer token-cliente" },
    ))
    const [call] = recordCalls(calls)
    assert.equal(call.body?.p_user_id, "cliente-real")
    assert.deepEqual(Object.keys(call.body ?? {}).sort(), ["p_client_key", "p_device_type", "p_product_id", "p_session_id", "p_source", "p_user_id"])
    assert.ok(!JSON.stringify(call.body).includes("persona@correo.com"))
  })
  await withSupabase({ userId: null }, async (calls) => {
    await route.POST(viewRequest({ sessionId: SESSION, productId: 7, source: "quick_view" }, { Authorization: "Bearer vencido" }))
    assert.equal(recordCalls(calls)[0].body?.p_user_id, null, "token inválido = visita anónima")
  })
})

test("product_view: equipo interno y robots no cuentan; payload inválido 400", async () => {
  const route = await import("../../app/api/analytics/product-view/route")
  for (const role of ["admin", "super_admin", "operador"]) {
    await withSupabase({ userId: "staff", role }, async (calls) => {
      const response = await route.POST(viewRequest({ sessionId: SESSION, productId: 7, source: "product_page" }, { Authorization: "Bearer staff" }))
      assert.equal(response.status, 204)
      assert.equal(recordCalls(calls).length, 0, role)
    })
  }
  await withSupabase({ userId: null }, async (calls) => {
    assert.equal((await route.POST(viewRequest({ sessionId: SESSION, productId: 7, source: "product_page" }, { "User-Agent": "Googlebot/2.1" }))).status, 204)
    assert.equal((await route.POST(viewRequest({ sessionId: "x", productId: 7, source: "product_page" }))).status, 400)
    assert.equal((await route.POST(viewRequest("{"))).status, 400)
    assert.equal(recordCalls(calls).length, 0)
  })
})

test("product_view: si la base falla, la respuesta sigue siendo 204 (analítica nunca rompe la navegación)", async () => {
  const route = await import("../../app/api/analytics/product-view/route")
  const warn = mock.method(console, "warn", () => {})
  try {
    await withSupabase({ userId: null, rpc: () => Response.json({ message: "boom", code: "XX000" }, { status: 500 }) }, async () => {
      assert.equal((await route.POST(viewRequest({ sessionId: SESSION, productId: 7, source: "product_page" }))).status, 204)
    })
    await withSupabase({ userId: null, rpc: () => { throw new TypeError("fetch failed") } }, async () => {
      assert.equal((await route.POST(viewRequest({ sessionId: SESSION, productId: 7, source: "product_page" }))).status, 204)
    })
  } finally { warn.mock.restore() }
})

const statsRequest = (query: string, token: string | null = "token") => new Request(`http://localhost/api/admin/analytics/product-views?${query}`, {
  headers: token ? { Authorization: `Bearer ${token}` } : {},
})

test("Admin > Analítica: anon 401, cliente y operador 403 sin tocar datos; Admin y Super Admin consultan", async () => {
  const route = await import("../../app/api/admin/analytics/product-views/route")
  await withSupabase({ userId: null }, async (calls) => {
    assert.equal((await route.GET(statsRequest("from=2026-10-20&to=2026-10-26", null))).status, 401)
    assert.equal((await route.GET(statsRequest("from=2026-10-20&to=2026-10-26"))).status, 401)
    assert.equal(calls.filter((call) => call.path.startsWith("/rest/v1/rpc/")).length, 0)
  })
  for (const role of ["cliente", "operador"]) {
    await withSupabase({ userId: "user", role }, async (calls) => {
      assert.equal((await route.GET(statsRequest("from=2026-10-20&to=2026-10-26"))).status, 403, role)
      assert.ok(calls.every((call) => call.path === "/rest/v1/profiles"), "un rechazo nunca consulta analytics")
    })
  }
  const rows = [
    { product_id: 2, product_name: "Soporte Notebook HUB", product_slug: "soporte-hub", product_image: null, views: "180" },
    { product_id: 1, product_name: "Auricular Malibu", product_slug: "auricular-malibu", product_image: "https://cdn.test/a.webp", views: "245" },
  ]
  for (const role of ["admin", "super_admin"]) {
    await withSupabase({ userId: "staff", role, rpc: () => Response.json(rows) }, async (calls) => {
      const response = await route.GET(statsRequest("from=2026-10-20&to=2026-10-26"))
      assert.equal(response.status, 200, role)
      assert.equal(response.headers.get("cache-control"), "private, no-store")
      const report = await response.json() as { totalViews: number; productsViewed: number; topProduct: { name: string }; ranking: { name: string; position: number }[] }
      assert.equal(report.totalViews, 425)
      assert.equal(report.productsViewed, 2)
      assert.equal(report.topProduct.name, "Auricular Malibu")
      assert.deepEqual(report.ranking.map((entry) => entry.position), [1, 2])
      const rpc = calls.find((call) => call.path === "/rest/v1/rpc/admin_product_view_stats")
      assert.deepEqual(rpc?.body, { p_from: "2026-10-20", p_to: "2026-10-26" })
    })
  }
})

test("Admin > Analítica: rango inválido 400 sin consultar; error de base 500 genérico", async () => {
  const route = await import("../../app/api/admin/analytics/product-views/route")
  await withSupabase({ userId: "staff", role: "admin" }, async (calls) => {
    for (const query of ["", "from=2026-10-26&to=2026-10-20", "from=2025-01-01&to=2026-10-26", "from=hoy&to=2026-10-26"]) {
      assert.equal((await route.GET(statsRequest(query))).status, 400, query)
    }
    assert.equal(calls.filter((call) => call.path.startsWith("/rest/v1/rpc/")).length, 0)
  })
  await withSupabase({ userId: "staff", role: "admin", rpc: () => Response.json({ message: "relation does not exist" }, { status: 500 }) }, async () => {
    const response = await route.GET(statsRequest("from=2026-10-20&to=2026-10-26"))
    assert.equal(response.status, 500)
    assert.deepEqual(await response.json(), { error: "No se pudieron cargar las vistas de productos." })
  })
})
