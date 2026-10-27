import assert from "node:assert/strict"
import test, { mock } from "node:test"
import { AuthClient } from "@supabase/supabase-js"

import { systemHealthCache } from "./system-health-checks"

// GET /api/admin/system-health con Supabase y proveedores simulados a nivel HTTP.

const MP_TOKEN = ["APP_USR", "998877", "token-ruta-secreto"].join("-")
const SERVICE_ROLE = "test-service-role-key-with-enough-length"
const ENV_KEYS = [
  "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY",
  "MERCADOPAGO_ACCESS_TOKEN", "NEXT_PUBLIC_SITE_URL", "ANDREANI_ENV", "ARCA_ENV", "ARCA_CERT", "ARCA_PRIVATE_KEY",
]

async function withEnvironment(
  options: { userId: string | null; role?: string; mercadoPago?: () => Response },
  run: (calls: string[]) => Promise<void>,
) {
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://health.invalid"
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon"
  process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE
  process.env.MERCADOPAGO_ACCESS_TOKEN = MP_TOKEN
  process.env.NEXT_PUBLIC_SITE_URL = "https://beyonix.test"
  for (const key of ["ANDREANI_ENV", "ARCA_ENV", "ARCA_CERT", "ARCA_PRIVATE_KEY"]) delete process.env[key]
  systemHealthCache.clear()

  const calls: string[] = []
  const claims = mock.method(AuthClient.prototype, "getClaims", async () => (
    options.userId === null ? { data: null, error: new Error("invalid") } : { data: { claims: { sub: options.userId } }, error: null }))
  const fetchMock = mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    calls.push(`${init?.method ?? "GET"} ${url.host}${url.pathname}`)
    if (url.pathname === "/rest/v1/profiles") {
      return Response.json(options.role ? { id: options.userId, email: null, rol: options.role } : null)
    }
    if (url.pathname === "/rest/v1/productos") return Response.json([{ id: 1 }])
    if (url.host === "api.mercadopago.com") return options.mercadoPago?.() ?? Response.json({ id: 42 })
    if (url.host === "beyonix.test") return Response.json({ settings: {} }, { headers: { "X-Settings-Source": "database" } })
    return new Response("inesperado", { status: 599 })
  })
  try {
    await run(calls)
  } finally {
    claims.mock.restore()
    fetchMock.mock.restore()
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  }
}

function request(token?: string, query = "") {
  return new Request(`http://localhost/api/admin/system-health${query}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
}

test("sin sesión o con token inválido: 401 y ningún proveedor consultado", async () => {
  const route = await import("../../app/api/admin/system-health/route")
  await withEnvironment({ userId: null }, async (calls) => {
    assert.equal((await route.GET(request())).status, 401)
    assert.equal((await route.GET(request("vencido"))).status, 401)
    assert.ok(!calls.some((call) => call.includes("mercadopago") || call.includes("beyonix.test")))
  })
})

test("cliente normal: 403 y ningún proveedor consultado", async () => {
  const route = await import("../../app/api/admin/system-health/route")
  await withEnvironment({ userId: "cliente-1", role: "cliente" }, async (calls) => {
    assert.equal((await route.GET(request("token-cliente"))).status, 403)
    assert.ok(!calls.some((call) => call.includes("mercadopago")))
  })
})

test("roles internos autorizados; respuesta privada, sin secretos y con cache compartido", async () => {
  const route = await import("../../app/api/admin/system-health/route")
  for (const role of ["operador", "admin", "super_admin"]) {
    await withEnvironment({ userId: `interno-${role}`, role }, async (calls) => {
      const response = await route.GET(request("token-interno"))
      assert.equal(response.status, 200, role)
      assert.match(response.headers.get("Cache-Control") ?? "", /private/)
      assert.match(response.headers.get("Cache-Control") ?? "", /no-store/)
      const text = await response.text()
      for (const secret of [MP_TOKEN, SERVICE_ROLE, "token-interno"]) assert.ok(!text.includes(secret), `${role}: ${secret}`)

      const body = JSON.parse(text) as { checks: Array<{ id: string; status: string }>; cached: boolean; pollAfterMs: number }
      assert.equal(body.pollAfterMs, 60_000)
      assert.equal(body.cached, false)
      const byId = Object.fromEntries(body.checks.map((check) => [check.id, check.status]))
      assert.deepEqual(byId, { store: "ok", mercadopago: "ok", andreani: "disabled", arca: "error" })

      const mpCalls = () => calls.filter((call) => call.includes("api.mercadopago.com")).length
      assert.equal(mpCalls(), 1)
      const second = await (await route.GET(request("token-interno"))).json() as { cached: boolean }
      assert.equal(second.cached, true, "segundo request dentro del TTL reutiliza")
      assert.equal(mpCalls(), 1)
      assert.ok(calls.every((call) => call.startsWith("GET ")), "sólo lecturas")
    })
  }
})

test("una excepción interna de un proveedor queda sanitizada y no rompe el resto", async () => {
  const route = await import("../../app/api/admin/system-health/route")
  await withEnvironment({
    userId: "admin-1",
    role: "admin",
    mercadoPago: () => { throw new Error(`stack ${MP_TOKEN} at /srv/beyonix/node_modules/x.js:1`) },
  }, async () => {
    const response = await route.GET(request("token-admin", "?force=1"))
    assert.equal(response.status, 200)
    const text = await response.text()
    assert.ok(!text.includes(MP_TOKEN))
    assert.ok(!text.includes("/srv/beyonix"))
    const body = JSON.parse(text) as { checks: Array<{ id: string; status: string; detail: string }> }
    const mercadoPago = body.checks.find((check) => check.id === "mercadopago")
    assert.equal(mercadoPago?.status, "error")
    assert.equal(mercadoPago?.detail, "No se pudo conectar con Mercado Pago.")
    assert.equal(body.checks.find((check) => check.id === "store")?.status, "ok")
  })
})
