import assert from "node:assert/strict"
import test, { mock } from "node:test"
import { AuthClient } from "@supabase/supabase-js"

// Rutas de Analítica con Supabase simulado a nivel HTTP: el beacon público
// `product_view` y la consulta de Admin > Analítica.

type Call = { path: string; body: Record<string, unknown> | null }

const SESSION = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b"
const BROWSER_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148 Safari"

async function withSupabase(
  options: { userId: string | null; role?: string | null; originSecret?: string; rpc?: (path: string, body: Record<string, unknown> | null) => Response },
  run: (calls: Call[]) => Promise<void>,
) {
  const previousEnv = { ...process.env }
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://analytics.invalid"
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key-with-enough-length"
  if (options.originSecret) process.env.ANALYTICS_ORIGIN_HASH_SECRET = options.originSecret
  else delete process.env.ANALYTICS_ORIGIN_HASH_SECRET
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
    for (const key of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "ANALYTICS_ORIGIN_HASH_SECRET"]) {
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

const ORIGIN_SECRET = "origin-secret-for-tests-with-enough-bytes"

test("product_view anónimo: registra sesión, producto, origen y dispositivo; nunca el IP", async () => {
  const route = await import("../../app/api/analytics/product-view/route")
  await withSupabase({ userId: null, originSecret: ORIGIN_SECRET }, async (calls) => {
    const response = await route.POST(viewRequest({ sessionId: SESSION, productId: 7, source: "product_page" }))
    assert.equal(response.status, 204)
    const [call] = recordCalls(calls)
    assert.ok(call)
    assert.equal(call.body?.p_session_id, SESSION)
    assert.equal(call.body?.p_product_id, 7)
    assert.equal(call.body?.p_user_id, null)
    assert.equal(call.body?.p_source, "product_page")
    assert.equal(call.body?.p_device_type, "mobile")
    const { getAnalyticsClientKey } = await import("../../lib/analytics/product-view-event")
    assert.equal(call.body?.p_client_key, getAnalyticsClientKey("203.0.113.9", ORIGIN_SECRET), "HMAC con el secreto dedicado")
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

test("product_view sin ANALYTICS_ORIGIN_HASH_SECRET: se registra igual, sin clave de origen, y nunca usa la service_role", async () => {
  const route = await import("../../app/api/analytics/product-view/route")
  const warn = mock.method(console, "warn", () => {})
  try {
    await withSupabase({ userId: null }, async (calls) => {
      assert.equal((await route.POST(viewRequest({ sessionId: SESSION, productId: 7, source: "product_page" }))).status, 204)
      assert.equal((await route.POST(viewRequest({ sessionId: SESSION, productId: 8, source: "product_page" }))).status, 204)
      const records = recordCalls(calls)
      assert.equal(records.length, 2, "las vistas se registran")
      assert.ok(records.every((call) => call.body?.p_client_key === null), "límite por origen desactivado")
    })
    const warnings = warn.mock.calls.map((call) => String(call.arguments[0]))
    assert.ok(warnings.filter((text) => text.includes("ANALYTICS_ORIGIN_HASH_SECRET")).length <= 1, "avisa una sola vez")
    assert.ok(warnings.every((text) => !text.includes("test-service-role")), "nunca expone secretos")
  } finally { warn.mock.restore() }
})

test("product_view: si la base falla responde 503 vacío para reintentar (el navegador nunca lo muestra)", async () => {
  const route = await import("../../app/api/analytics/product-view/route")
  const warn = mock.method(console, "warn", () => {})
  try {
    await withSupabase({ userId: null, rpc: () => Response.json({ message: "boom", code: "XX000" }, { status: 500 }) }, async () => {
      const response = await route.POST(viewRequest({ sessionId: SESSION, productId: 7, source: "product_page" }))
      assert.equal(response.status, 503)
      assert.equal(await response.text(), "", "sin detalle del error")
    })
    await withSupabase({ userId: null, rpc: () => { throw new TypeError("fetch failed") } }, async () => {
      assert.equal((await route.POST(viewRequest({ sessionId: SESSION, productId: 7, source: "product_page" }))).status, 503)
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
    { product_id: 2, product_name: "Soporte Notebook HUB", product_slug: "soporte-hub", product_image: null, product_available: false, views: "180" },
    { product_id: 1, product_name: "Auricular Malibu", product_slug: "auricular-malibu", product_image: "https://cdn.test/a.webp", product_available: true, views: "245" },
  ]
  for (const role of ["admin", "super_admin"]) {
    await withSupabase({ userId: "staff", role, rpc: () => Response.json(rows) }, async (calls) => {
      const response = await route.GET(statsRequest("from=2026-10-20&to=2026-10-26"))
      assert.equal(response.status, 200, role)
      assert.equal(response.headers.get("cache-control"), "private, no-store")
      const report = await response.json() as { totalViews: number; productsViewed: number; topProduct: { name: string }; ranking: { name: string; position: number; available: boolean }[] }
      assert.equal(report.totalViews, 425)
      assert.equal(report.productsViewed, 2)
      assert.equal(report.topProduct.name, "Auricular Malibu")
      assert.deepEqual(report.ranking.map((entry) => [entry.position, entry.available]), [[1, true], [2, false]], "archivado/eliminado: sigue contando, sin PDP")
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

const peakRequest = (query: string, token: string | null = "token") => new Request(`http://localhost/api/admin/analytics/peak-hour?${query}`, {
  headers: token ? { Authorization: `Bearer ${token}` } : {},
})

test("Horario pico: anon 401, cliente y operador 403; Admin y Super Admin reciben sólo el agregado", async () => {
  const route = await import("../../app/api/admin/analytics/peak-hour/route")
  await withSupabase({ userId: null }, async (calls) => {
    assert.equal((await route.GET(peakRequest("from=2026-10-20&to=2026-10-26", null))).status, 401)
    assert.equal((await route.GET(peakRequest("from=2026-10-20&to=2026-10-26"))).status, 401)
    assert.equal(calls.filter((call) => call.path.startsWith("/rest/v1/rpc/")).length, 0)
  })
  for (const role of ["cliente", "operador"]) {
    await withSupabase({ userId: "user", role }, async (calls) => {
      assert.equal((await route.GET(peakRequest("from=2026-10-20&to=2026-10-26"))).status, 403, role)
      assert.ok(calls.every((call) => call.path === "/rest/v1/profiles"))
    })
  }
  for (const role of ["admin", "super_admin"]) {
    await withSupabase({ userId: "staff", role, rpc: () => Response.json([{ peak_hour: 14, peak_views: "28", total_views: "155" }]) }, async (calls) => {
      const response = await route.GET(peakRequest("from=2026-10-20&to=2026-10-26"))
      assert.equal(response.status, 200, role)
      assert.equal(response.headers.get("cache-control"), "private, no-store")
      const report = await response.json() as { totalViews: number; peak: { hour: number; views: number; sharePercent: number } }
      assert.equal(report.totalViews, 155)
      assert.deepEqual([report.peak.hour, report.peak.views], [14, 28])
      const rpc = calls.find((call) => call.path === "/rest/v1/rpc/admin_product_view_peak_hour")
      assert.deepEqual(rpc?.body, { p_from: "2026-10-20", p_to: "2026-10-26" })
    })
  }
})

test("Horario pico: sin vistas → peak null; rango inválido 400; error de base 500 genérico", async () => {
  const route = await import("../../app/api/admin/analytics/peak-hour/route")
  await withSupabase({ userId: "staff", role: "admin", rpc: () => Response.json([]) }, async () => {
    const response = await route.GET(peakRequest("from=2026-10-26&to=2026-10-26"))
    assert.deepEqual(await response.json(), { range: { from: "2026-10-26", to: "2026-10-26" }, totalViews: 0, peak: null })
  })
  await withSupabase({ userId: "staff", role: "admin" }, async (calls) => {
    for (const query of ["", "from=2026-10-26&to=2026-10-20", "from=2025-01-01&to=2026-10-26", "from=2026-02-30&to=2026-03-01"]) {
      assert.equal((await route.GET(peakRequest(query))).status, 400, query)
    }
    assert.equal(calls.filter((call) => call.path.startsWith("/rest/v1/rpc/")).length, 0)
  })
  await withSupabase({ userId: "staff", role: "admin", rpc: () => Response.json({ message: "function does not exist" }, { status: 500 }) }, async () => {
    const response = await route.GET(peakRequest("from=2026-10-20&to=2026-10-26"))
    assert.equal(response.status, 500)
    assert.deepEqual(await response.json(), { error: "No se pudo cargar el horario pico de visualizaciones." })
  })
})

const weekdayRequest = (query: string, token: string | null = "token") => new Request(`http://localhost/api/admin/analytics/peak-weekday?${query}`, {
  headers: token ? { Authorization: `Bearer ${token}` } : {},
})

test("Día con más visualizaciones: anon 401, cliente y operador 403; Admin y Super Admin reciben sólo el agregado", async () => {
  const route = await import("../../app/api/admin/analytics/peak-weekday/route")
  await withSupabase({ userId: null }, async (calls) => {
    assert.equal((await route.GET(weekdayRequest("from=2026-10-20&to=2026-10-26", null))).status, 401)
    assert.equal((await route.GET(weekdayRequest("from=2026-10-20&to=2026-10-26"))).status, 401)
    assert.equal(calls.filter((call) => call.path.startsWith("/rest/v1/rpc/")).length, 0)
  })
  for (const role of ["cliente", "operador"]) {
    await withSupabase({ userId: "user", role }, async (calls) => {
      assert.equal((await route.GET(weekdayRequest("from=2026-10-20&to=2026-10-26"))).status, 403, role)
      assert.ok(calls.every((call) => call.path === "/rest/v1/profiles"))
    })
  }
  for (const role of ["admin", "super_admin"]) {
    await withSupabase({ userId: "staff", role, rpc: () => Response.json([{ peak_weekday: 6, peak_views: "84", total_views: "262" }]) }, async (calls) => {
      const response = await route.GET(weekdayRequest("from=2026-10-20&to=2026-10-26"))
      assert.equal(response.status, 200, role)
      assert.equal(response.headers.get("cache-control"), "private, no-store")
      const report = await response.json() as { totalViews: number; peak: { weekday: number; views: number; sharePercent: number } }
      assert.equal(report.totalViews, 262)
      assert.deepEqual([report.peak.weekday, report.peak.views], [6, 84])
      assert.ok(Math.abs(report.peak.sharePercent - (84 / 262) * 100) < 1e-9)
      const rpc = calls.find((call) => call.path === "/rest/v1/rpc/admin_product_view_peak_weekday")
      assert.deepEqual(rpc?.body, { p_from: "2026-10-20", p_to: "2026-10-26" })
    })
  }
})

test("Día con más visualizaciones: sin vistas → peak null; rango inválido 400; error de base 500 genérico", async () => {
  const route = await import("../../app/api/admin/analytics/peak-weekday/route")
  await withSupabase({ userId: "staff", role: "admin", rpc: () => Response.json([]) }, async () => {
    const response = await route.GET(weekdayRequest("from=2026-10-26&to=2026-10-26"))
    assert.deepEqual(await response.json(), { range: { from: "2026-10-26", to: "2026-10-26" }, totalViews: 0, peak: null })
  })
  await withSupabase({ userId: "staff", role: "admin" }, async (calls) => {
    for (const query of ["", "from=2026-10-26&to=2026-10-20", "from=2025-01-01&to=2026-10-26", "from=2026-02-30&to=2026-03-01"]) {
      assert.equal((await route.GET(weekdayRequest(query))).status, 400, query)
    }
    assert.equal(calls.filter((call) => call.path.startsWith("/rest/v1/rpc/")).length, 0)
  })
  await withSupabase({ userId: "staff", role: "admin", rpc: () => Response.json({ message: "function does not exist" }, { status: 500 }) }, async () => {
    const response = await route.GET(weekdayRequest("from=2026-10-20&to=2026-10-26"))
    assert.equal(response.status, 500)
    assert.deepEqual(await response.json(), { error: "No se pudo cargar el día con más visualizaciones." })
  })
})

const weekdayViewsRequest = (query: string, token: string | null = "token") => new Request(`http://localhost/api/admin/analytics/views-by-weekday?${query}`, {
  headers: token ? { Authorization: `Bearer ${token}` } : {},
})

test("Visualizaciones por día: anon 401, cliente y operador 403; Admin y Super Admin reciben los 7 días", async () => {
  const route = await import("../../app/api/admin/analytics/views-by-weekday/route")
  await withSupabase({ userId: null }, async (calls) => {
    assert.equal((await route.GET(weekdayViewsRequest("from=2026-10-20&to=2026-10-26", null))).status, 401)
    assert.equal((await route.GET(weekdayViewsRequest("from=2026-10-20&to=2026-10-26"))).status, 401)
    assert.equal(calls.filter((call) => call.path.startsWith("/rest/v1/rpc/")).length, 0)
  })
  for (const role of ["cliente", "operador"]) {
    await withSupabase({ userId: "user", role }, async (calls) => {
      assert.equal((await route.GET(weekdayViewsRequest("from=2026-10-20&to=2026-10-26"))).status, 403, role)
      assert.ok(calls.every((call) => call.path === "/rest/v1/profiles"))
    })
  }
  for (const role of ["admin", "super_admin"]) {
    await withSupabase({ userId: "staff", role, rpc: () => Response.json([{ weekday: 1, view_count: "110" }, { weekday: 3, view_count: 145 }, { weekday: 6, view_count: "210" }]) }, async (calls) => {
      const response = await route.GET(weekdayViewsRequest("from=2026-10-20&to=2026-10-26"))
      assert.equal(response.status, 200, role)
      assert.equal(response.headers.get("cache-control"), "private, no-store")
      const report = await response.json() as { totalViews: number; days: { weekday: number; views: number; sharePercent: number }[] }
      assert.equal(report.totalViews, 465)
      assert.deepEqual(report.days.map((day) => [day.weekday, day.views]), [[1, 110], [2, 0], [3, 145], [4, 0], [5, 0], [6, 210], [7, 0]])
      assert.ok(Math.abs(report.days[2].sharePercent - (145 / 465) * 100) < 1e-9)
      const rpc = calls.find((call) => call.path === "/rest/v1/rpc/admin_product_views_by_weekday")
      assert.deepEqual(rpc?.body, { p_from: "2026-10-20", p_to: "2026-10-26" })
    })
  }
})

test("Visualizaciones por día: sin vistas → 7 ceros; rango inválido 400; error de base 500 genérico", async () => {
  const route = await import("../../app/api/admin/analytics/views-by-weekday/route")
  await withSupabase({ userId: "staff", role: "admin", rpc: () => Response.json([]) }, async () => {
    const report = await (await route.GET(weekdayViewsRequest("from=2026-10-26&to=2026-10-26"))).json() as { totalViews: number; days: { views: number; sharePercent: number }[] }
    assert.equal(report.totalViews, 0)
    assert.deepEqual(report.days.map((day) => [day.views, day.sharePercent]), Array.from({ length: 7 }, () => [0, 0]))
  })
  await withSupabase({ userId: "staff", role: "admin" }, async (calls) => {
    for (const query of ["", "from=2026-10-26&to=2026-10-20", "from=2025-01-01&to=2026-10-26", "from=2026-02-30&to=2026-03-01"]) {
      assert.equal((await route.GET(weekdayViewsRequest(query))).status, 400, query)
    }
    assert.equal(calls.filter((call) => call.path.startsWith("/rest/v1/rpc/")).length, 0)
  })
  await withSupabase({ userId: "staff", role: "admin", rpc: () => Response.json({ message: "function does not exist" }, { status: 500 }) }, async () => {
    const response = await route.GET(weekdayViewsRequest("from=2026-10-20&to=2026-10-26"))
    assert.equal(response.status, 500)
    assert.deepEqual(await response.json(), { error: "No se pudieron cargar las visualizaciones por día de la semana." })
  })
})

const hourlyViewsRequest = (query: string, token: string | null = "token") => new Request(`http://localhost/api/admin/analytics/views-by-hour?${query}`, {
  headers: token ? { Authorization: `Bearer ${token}` } : {},
})

test("Visualizaciones por hora: anon 401, cliente y operador 403; Admin y Super Admin reciben las 24 horas", async () => {
  const route = await import("../../app/api/admin/analytics/views-by-hour/route")
  await withSupabase({ userId: null }, async (calls) => {
    assert.equal((await route.GET(hourlyViewsRequest("from=2026-10-20&to=2026-10-26", null))).status, 401)
    assert.equal((await route.GET(hourlyViewsRequest("from=2026-10-20&to=2026-10-26"))).status, 401)
    assert.equal(calls.filter((call) => call.path.startsWith("/rest/v1/rpc/")).length, 0)
  })
  for (const role of ["cliente", "operador"]) {
    await withSupabase({ userId: "user", role }, async (calls) => {
      assert.equal((await route.GET(hourlyViewsRequest("from=2026-10-20&to=2026-10-26"))).status, 403, role)
      assert.ok(calls.every((call) => call.path === "/rest/v1/profiles"))
    })
  }
  for (const role of ["admin", "super_admin"]) {
    await withSupabase({ userId: "staff", role, rpc: () => Response.json([{ hour: 0, view_count: "2" }, { hour: 9, view_count: 27 }, { hour: 20, view_count: "45" }, { hour: 23, view_count: "176" }]) }, async (calls) => {
      const response = await route.GET(hourlyViewsRequest("from=2026-10-20&to=2026-10-26"))
      assert.equal(response.status, 200, role)
      assert.equal(response.headers.get("cache-control"), "private, no-store")
      const report = await response.json() as { totalViews: number; hours: { hour: number; views: number; sharePercent: number }[] }
      assert.equal(report.totalViews, 250)
      assert.equal(report.hours.length, 24)
      assert.deepEqual(report.hours.filter((slot) => slot.views > 0).map((slot) => [slot.hour, slot.views]), [[0, 2], [9, 27], [20, 45], [23, 176]])
      assert.equal(report.hours[20].sharePercent, 18)
      const rpc = calls.find((call) => call.path === "/rest/v1/rpc/admin_product_views_by_hour")
      assert.deepEqual(rpc?.body, { p_from: "2026-10-20", p_to: "2026-10-26" })
    })
  }
})

test("Visualizaciones por hora: sin vistas → 24 ceros; rango inválido 400; error de base 500 genérico", async () => {
  const route = await import("../../app/api/admin/analytics/views-by-hour/route")
  await withSupabase({ userId: "staff", role: "admin", rpc: () => Response.json([]) }, async () => {
    const report = await (await route.GET(hourlyViewsRequest("from=2026-10-26&to=2026-10-26"))).json() as { totalViews: number; hours: { views: number; sharePercent: number }[] }
    assert.equal(report.totalViews, 0)
    assert.deepEqual(report.hours.map((slot) => [slot.views, slot.sharePercent]), Array.from({ length: 24 }, () => [0, 0]))
  })
  await withSupabase({ userId: "staff", role: "admin" }, async (calls) => {
    for (const query of ["", "from=2026-10-26&to=2026-10-20", "from=2025-01-01&to=2026-10-26", "from=2026-02-30&to=2026-03-01"]) {
      assert.equal((await route.GET(hourlyViewsRequest(query))).status, 400, query)
    }
    assert.equal(calls.filter((call) => call.path.startsWith("/rest/v1/rpc/")).length, 0)
  })
  await withSupabase({ userId: "staff", role: "admin", rpc: () => Response.json({ message: "function does not exist" }, { status: 500 }) }, async () => {
    const response = await route.GET(hourlyViewsRequest("from=2026-10-20&to=2026-10-26"))
    assert.equal(response.status, 500)
    assert.deepEqual(await response.json(), { error: "No se pudieron cargar las visualizaciones por hora del día." })
  })
})

const sessionStatsRequest = (query: string, token: string | null = "token") => new Request(`http://localhost/api/admin/analytics/session-stats?${query}`, {
  headers: token ? { Authorization: `Bearer ${token}` } : {},
})

test("Sesiones con visualizaciones: anon 401, cliente y operador 403; Admin y Super Admin reciben sesiones y promedio", async () => {
  const route = await import("../../app/api/admin/analytics/session-stats/route")
  await withSupabase({ userId: null }, async (calls) => {
    assert.equal((await route.GET(sessionStatsRequest("from=2026-10-20&to=2026-10-26", null))).status, 401)
    assert.equal((await route.GET(sessionStatsRequest("from=2026-10-20&to=2026-10-26"))).status, 401)
    assert.equal(calls.filter((call) => call.path.startsWith("/rest/v1/rpc/")).length, 0)
  })
  for (const role of ["cliente", "operador"]) {
    await withSupabase({ userId: "user", role }, async (calls) => {
      assert.equal((await route.GET(sessionStatsRequest("from=2026-10-20&to=2026-10-26"))).status, 403, role)
      assert.ok(calls.every((call) => call.path === "/rest/v1/profiles"))
    })
  }
  for (const role of ["admin", "super_admin"]) {
    await withSupabase({ userId: "staff", role, rpc: () => Response.json([{ total_views: "10", unique_sessions: "3" }]) }, async (calls) => {
      const response = await route.GET(sessionStatsRequest("from=2026-10-20&to=2026-10-26"))
      assert.equal(response.status, 200, role)
      assert.equal(response.headers.get("cache-control"), "private, no-store")
      const report = await response.json() as { totalViews: number; sessions: number; viewsPerSession: number }
      assert.deepEqual([report.totalViews, report.sessions], [10, 3])
      assert.ok(Math.abs(report.viewsPerSession - 10 / 3) < 1e-9)
      const rpc = calls.find((call) => call.path === "/rest/v1/rpc/admin_product_view_session_stats")
      assert.deepEqual(rpc?.body, { p_from: "2026-10-20", p_to: "2026-10-26" })
    })
  }
})

test("Sesiones con visualizaciones: sin vistas → 0 y promedio null; rango inválido 400; error de base 500 genérico", async () => {
  const route = await import("../../app/api/admin/analytics/session-stats/route")
  await withSupabase({ userId: "staff", role: "admin", rpc: () => Response.json([{ total_views: 0, unique_sessions: 0 }]) }, async () => {
    assert.deepEqual(await (await route.GET(sessionStatsRequest("from=2026-10-26&to=2026-10-26"))).json(), {
      range: { from: "2026-10-26", to: "2026-10-26" }, totalViews: 0, sessions: 0, viewsPerSession: null,
    })
  })
  await withSupabase({ userId: "staff", role: "admin" }, async (calls) => {
    for (const query of ["", "from=2026-10-26&to=2026-10-20", "from=2025-01-01&to=2026-10-26", "from=2026-02-30&to=2026-03-01"]) {
      assert.equal((await route.GET(sessionStatsRequest(query))).status, 400, query)
    }
    assert.equal(calls.filter((call) => call.path.startsWith("/rest/v1/rpc/")).length, 0)
  })
  await withSupabase({ userId: "staff", role: "admin", rpc: () => Response.json({ message: "function does not exist" }, { status: 500 }) }, async () => {
    const response = await route.GET(sessionStatsRequest("from=2026-10-20&to=2026-10-26"))
    assert.equal(response.status, 500)
    assert.deepEqual(await response.json(), { error: "No se pudieron cargar las sesiones con visualizaciones." })
  })
})

const comparisonRequest = (query: string, token: string | null = "token") => new Request(`http://localhost/api/admin/analytics/comparison?${query}`, {
  headers: token ? { Authorization: `Bearer ${token}` } : {},
})

const COMPARISON_ROW = {
  current_total_views: "100", current_products_viewed: "12", current_sessions: "20",
  previous_total_views: 60, previous_products_viewed: "12", previous_sessions: "20",
}

test("Comparación: anon 401, cliente y operador 403; Admin y Super Admin reciben actual y anterior en una sola consulta", async () => {
  const route = await import("../../app/api/admin/analytics/comparison/route")
  await withSupabase({ userId: null }, async (calls) => {
    assert.equal((await route.GET(comparisonRequest("from=2026-10-21&to=2026-10-27", null))).status, 401)
    assert.equal((await route.GET(comparisonRequest("from=2026-10-21&to=2026-10-27"))).status, 401)
    assert.equal(calls.filter((call) => call.path.startsWith("/rest/v1/rpc/")).length, 0)
  })
  for (const role of ["cliente", "operador"]) {
    await withSupabase({ userId: "user", role }, async (calls) => {
      assert.equal((await route.GET(comparisonRequest("from=2026-10-21&to=2026-10-27"))).status, 403, role)
      assert.ok(calls.every((call) => call.path === "/rest/v1/profiles"))
    })
  }
  for (const role of ["admin", "super_admin"]) {
    await withSupabase({ userId: "staff", role, rpc: () => Response.json([COMPARISON_ROW]) }, async (calls) => {
      // El período anterior que mande el cliente se ignora: lo deriva el servidor.
      const response = await route.GET(comparisonRequest("from=2026-10-21&to=2026-10-27&p_previous_from=2020-01-01&p_previous_to=2020-01-07"))
      assert.equal(response.status, 200, role)
      assert.equal(response.headers.get("cache-control"), "private, no-store")
      const report = await response.json() as { previousRange: unknown; current: { totalViews: number; viewsPerSession: number }; previous: { totalViews: number; viewsPerSession: number } }
      assert.deepEqual(report.previousRange, { from: "2026-10-14", to: "2026-10-20" })
      assert.deepEqual([report.current.totalViews, report.current.viewsPerSession, report.previous.totalViews, report.previous.viewsPerSession], [100, 5, 60, 3])
      const rpcCalls = calls.filter((call) => call.path.startsWith("/rest/v1/rpc/"))
      assert.equal(rpcCalls.length, 1, "una sola consulta para las cuatro métricas y los dos períodos")
      assert.equal(rpcCalls[0].path, "/rest/v1/rpc/admin_product_view_period_comparison")
      assert.deepEqual(rpcCalls[0].body, { p_from: "2026-10-21", p_to: "2026-10-27", p_previous_from: "2026-10-14", p_previous_to: "2026-10-20" })
    })
  }
})

test("Comparación: Hoy contra ayer; rango inválido 400 sin consultar; error de base 500 genérico", async () => {
  const route = await import("../../app/api/admin/analytics/comparison/route")
  await withSupabase({ userId: "staff", role: "admin", rpc: () => Response.json([COMPARISON_ROW]) }, async (calls) => {
    await route.GET(comparisonRequest("from=2026-10-27&to=2026-10-27"))
    assert.deepEqual(calls.find((call) => call.path === "/rest/v1/rpc/admin_product_view_period_comparison")?.body, {
      p_from: "2026-10-27", p_to: "2026-10-27", p_previous_from: "2026-10-26", p_previous_to: "2026-10-26",
    })
  })
  await withSupabase({ userId: "staff", role: "admin" }, async (calls) => {
    for (const query of ["", "from=2026-10-26&to=2026-10-20", "from=2025-01-01&to=2026-10-26", "from=2026-02-30&to=2026-03-01"]) {
      assert.equal((await route.GET(comparisonRequest(query))).status, 400, query)
    }
    assert.equal(calls.filter((call) => call.path.startsWith("/rest/v1/rpc/")).length, 0)
  })
  await withSupabase({ userId: "staff", role: "admin", rpc: () => Response.json({ message: "function does not exist" }, { status: 500 }) }, async () => {
    const response = await route.GET(comparisonRequest("from=2026-10-21&to=2026-10-27"))
    assert.equal(response.status, 500)
    assert.deepEqual(await response.json(), { error: "No se pudo cargar la comparación con el período anterior." })
  })
})

// --- Beacons comerciales -------------------------------------------------------------

const EVENT_ID = "11111111-2222-4333-8444-555555555555"
const rpcCalls = (calls: Call[], fn: string) => calls.filter((call) => call.path === `/rest/v1/rpc/${fn}`)

test("add_to_cart: el usuario sale del token, nunca del payload; producto, variante e id de la acción a la RPC", async () => {
  const route = await import("../../app/api/analytics/add-to-cart/route")
  await withSupabase({ userId: "cliente-real", role: "cliente" }, async (calls) => {
    const response = await route.POST(viewRequest(
      { sessionId: SESSION, eventId: EVENT_ID, productId: 7, variantId: 91, userId: "otro", price: 1, quantity: 99 },
      { Authorization: "Bearer token-cliente" },
    ))
    assert.equal(response.status, 204)
    const [call] = rpcCalls(calls, "record_add_to_cart")
    assert.deepEqual(call.body, {
      p_session_id: SESSION, p_client_event_id: EVENT_ID, p_product_id: 7, p_variant_id: 91,
      p_user_id: "cliente-real", p_device_type: "mobile", p_client_key: null,
    })
  })
  await withSupabase({ userId: null }, async (calls) => {
    for (const body of [{ sessionId: SESSION, productId: 7 }, { sessionId: SESSION, eventId: EVENT_ID, productId: -7 }, { sessionId: SESSION, eventId: EVENT_ID, productId: 7, variantId: "91" }]) {
      assert.equal((await route.POST(viewRequest(body))).status, 400, JSON.stringify(body))
    }
    assert.equal(rpcCalls(calls, "record_add_to_cart").length, 0)
  })
})

test("add_to_cart, search y checkout_started: equipo interno y robots no cuentan; base caída → 503 vacío", async () => {
  const add = await import("../../app/api/analytics/add-to-cart/route")
  const search = await import("../../app/api/analytics/search/route")
  const checkout = await import("../../app/api/analytics/checkout-started/route")
  const beacons = [
    () => add.POST(viewRequest({ sessionId: SESSION, eventId: EVENT_ID, productId: 7 }, { Authorization: "Bearer staff" })),
    () => search.POST(viewRequest({ sessionId: SESSION, eventId: EVENT_ID, query: "mate" }, { Authorization: "Bearer staff" })),
    () => checkout.POST(viewRequest({ sessionId: SESSION }, { Authorization: "Bearer staff" })),
  ]
  for (const role of ["admin", "super_admin", "operador"]) {
    await withSupabase({ userId: "staff", role }, async (calls) => {
      for (const send of beacons) assert.equal((await send()).status, 204)
      assert.equal(calls.filter((call) => call.path.startsWith("/rest/v1/rpc/")).length, 0, role)
    })
  }
  await withSupabase({ userId: null }, async (calls) => {
    assert.equal((await checkout.POST(viewRequest({ sessionId: SESSION }, { "User-Agent": "Googlebot/2.1" }))).status, 204)
    assert.equal(calls.filter((call) => call.path.startsWith("/rest/v1/rpc/")).length, 0, "robot")
  })
  const warn = mock.method(console, "warn", () => {})
  try {
    await withSupabase({ userId: null, rpc: () => Response.json({ message: "boom", code: "XX000" }, { status: 500 }) }, async () => {
      const response = await checkout.POST(viewRequest({ sessionId: SESSION }))
      assert.equal(response.status, 503)
      assert.equal(await response.text(), "")
    })
  } finally { warn.mock.restore() }
})

test("search: llega normalizada; con datos sensibles se descarta sin tocar la base; los resultados nunca vienen del cliente", async () => {
  const route = await import("../../app/api/analytics/search/route")
  await withSupabase({ userId: null }, async (calls) => {
    assert.equal((await route.POST(viewRequest({ sessionId: SESSION, eventId: EVENT_ID, query: "  Lámpara   ÑANDÚ ", results: 999 }))).status, 204)
    const [call] = rpcCalls(calls, "record_search")
    assert.deepEqual(call.body, {
      p_session_id: SESSION, p_client_event_id: EVENT_ID, p_query: "lámpara ñandú", p_user_id: null, p_device_type: "mobile", p_client_key: null,
    })
    for (const query of ["ana@test.com", "11 4444 5555", "4509 9535 6623 3704", "   "]) {
      assert.equal((await route.POST(viewRequest({ sessionId: SESSION, eventId: EVENT_ID, query }))).status, 204, query)
    }
    assert.equal(rpcCalls(calls, "record_search").length, 1, "lo sensible nunca llega a la base")
    assert.ok(!JSON.stringify(calls).includes("ana@test.com"))
    assert.equal((await route.POST(viewRequest({ sessionId: SESSION, eventId: EVENT_ID, query: 5 }))).status, 400)
  })
})

test("checkout_started: sólo la sesión; orden, total o usuario del payload se ignoran", async () => {
  const route = await import("../../app/api/analytics/checkout-started/route")
  await withSupabase({ userId: null }, async (calls) => {
    assert.equal((await route.POST(viewRequest({ sessionId: SESSION, orderId: 123, total: 1, userId: "x" }))).status, 204)
    assert.deepEqual(rpcCalls(calls, "record_checkout_started")[0].body, { p_session_id: SESSION, p_user_id: null, p_device_type: "mobile", p_client_key: null })
    assert.equal((await route.POST(viewRequest({}))).status, 400)
  })
})

// --- Reportes comerciales de Admin > Analítica ----------------------------------------

const adminRequest = (path: string, query: string, token: string | null = "token") => new Request(`http://localhost/api/admin/analytics/${path}?${query}`, {
  headers: token ? { Authorization: `Bearer ${token}` } : {},
})

const FUNNEL_ROW = {
  viewed_sessions: "1000", cart_sessions: "260", checkout_sessions: "125", funnel_cart: "250", funnel_checkout: "120", funnel_purchase: "60",
  purchases: "70", attributed_purchases: "60", revenue: "700000.00", attributed_revenue: "600000.00",
  evaluated_carts: "240", abandoned_carts: "120", abandoned_checkouts: "60", carts_in_progress: "20",
}

const COMMERCE_ENDPOINTS = [
  { path: "commerce", load: () => import("../../app/api/admin/analytics/commerce/route"), rpc: "admin_commerce_funnel", error: "No se pudo cargar la conversión.",
    rows: [{ period: "current", ...FUNNEL_ROW }, { period: "previous", ...FUNNEL_ROW, funnel_purchase: "50" }] },
  { path: "product-conversion", load: () => import("../../app/api/admin/analytics/product-conversion/route"), rpc: "admin_product_conversion", error: "No se pudo cargar la conversión por producto.",
    rows: [{ product_id: "1", product_name: "Auricular Legatus", product_slug: "legatus", product_image: null, product_available: true, viewed_sessions: "120", added_sessions: "30", purchased_sessions: "8" }] },
  { path: "searches", load: () => import("../../app/api/admin/analytics/searches/route"), rpc: "admin_search_stats", error: "No se pudieron cargar las búsquedas.",
    rows: [{ kind: "total", term: null, searches: "48", sessions: "30" }, { kind: "top", term: "auriculares", searches: "48", sessions: "30" }] },
] as const

test("reportes comerciales: anon 401, cliente y operador 403; Admin y Super Admin reciben sólo el agregado, private/no-store", async () => {
  for (const endpoint of COMMERCE_ENDPOINTS) {
    const route = await endpoint.load()
    await withSupabase({ userId: null }, async (calls) => {
      assert.equal((await route.GET(adminRequest(endpoint.path, "from=2026-10-21&to=2026-10-27", null))).status, 401, endpoint.path)
      assert.equal(calls.filter((call) => call.path.startsWith("/rest/v1/rpc/")).length, 0)
    })
    for (const role of ["cliente", "operador"]) {
      await withSupabase({ userId: "user", role }, async (calls) => {
        assert.equal((await route.GET(adminRequest(endpoint.path, "from=2026-10-21&to=2026-10-27"))).status, 403, `${endpoint.path} ${role}`)
        assert.ok(calls.every((call) => call.path === "/rest/v1/profiles"))
      })
    }
    for (const role of ["admin", "super_admin"]) {
      await withSupabase({ userId: "staff", role, rpc: () => Response.json(endpoint.rows) }, async (calls) => {
        const response = await route.GET(adminRequest(endpoint.path, "from=2026-10-21&to=2026-10-27"))
        assert.equal(response.status, 200, `${endpoint.path} ${role}`)
        assert.equal(response.headers.get("cache-control"), "private, no-store")
        const rpc = calls.filter((call) => call.path.startsWith("/rest/v1/rpc/"))
        assert.equal(rpc.length, 1, "una sola consulta por módulo")
        assert.equal(rpc[0].path, `/rest/v1/rpc/${endpoint.rpc}`)
        assert.deepEqual(rpc[0].body, endpoint.path === "commerce"
          ? { p_from: "2026-10-21", p_to: "2026-10-27", p_previous_from: "2026-10-14", p_previous_to: "2026-10-20" }
          : { p_from: "2026-10-21", p_to: "2026-10-27" })
      })
    }
  }
})

test("reportes comerciales: contenido, rango inválido 400 sin consultar, error de base 500 genérico", async () => {
  const [commerce, conversion, searches] = await Promise.all(COMMERCE_ENDPOINTS.map((endpoint) => endpoint.load()))
  await withSupabase({ userId: "staff", role: "admin", rpc: () => Response.json(COMMERCE_ENDPOINTS[0].rows) }, async () => {
    const report = await (await commerce.GET(adminRequest("commerce", "from=2026-10-21&to=2026-10-27"))).json() as { previousRange: unknown; current: { funnelPurchase: number; revenue: number }; previous: { funnelPurchase: number } }
    assert.deepEqual([report.current.funnelPurchase, report.current.revenue, report.previous.funnelPurchase], [60, 700000, 50])
    assert.deepEqual(report.previousRange, { from: "2026-10-14", to: "2026-10-20" })
  })
  await withSupabase({ userId: "staff", role: "admin", rpc: () => Response.json(COMMERCE_ENDPOINTS[1].rows) }, async () => {
    const report = await (await conversion.GET(adminRequest("product-conversion", "from=2026-10-21&to=2026-10-27"))).json() as { products: { name: string; available: boolean; cartRate: number; purchaseRate: number }[] }
    assert.deepEqual(report.products.map((row) => [row.name, row.available, row.cartRate]), [["Auricular Legatus", true, 0.25]])
  })
  await withSupabase({ userId: "staff", role: "admin", rpc: () => Response.json(COMMERCE_ENDPOINTS[2].rows) }, async () => {
    const report = await (await searches.GET(adminRequest("searches", "from=2026-10-21&to=2026-10-27"))).json() as { totalSearches: number; top: unknown[] }
    assert.deepEqual([report.totalSearches, report.top], [48, [{ term: "auriculares", searches: 48 }]])
  })
  for (const [index, route] of [commerce, conversion, searches].entries()) {
    const endpoint = COMMERCE_ENDPOINTS[index]
    await withSupabase({ userId: "staff", role: "admin" }, async (calls) => {
      for (const query of ["", "from=2026-10-26&to=2026-10-20", "from=2025-01-01&to=2026-10-26"]) {
        assert.equal((await route.GET(adminRequest(endpoint.path, query))).status, 400, `${endpoint.path} ${query}`)
      }
      assert.equal(calls.filter((call) => call.path.startsWith("/rest/v1/rpc/")).length, 0)
    })
    await withSupabase({ userId: "staff", role: "admin", rpc: () => Response.json({ message: "function does not exist" }, { status: 500 }) }, async () => {
      const response = await route.GET(adminRequest(endpoint.path, "from=2026-10-21&to=2026-10-27"))
      assert.equal(response.status, 500)
      assert.deepEqual(await response.json(), { error: endpoint.error })
    })
  }
})