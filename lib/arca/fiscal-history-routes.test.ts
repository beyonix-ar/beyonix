import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test, { mock } from "node:test"
import { AuthClient } from "@supabase/supabase-js"

test("historial y ZIP globales rechazan cliente y operador antes de consultar comprobantes", async () => {
  const previousUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fiscal-test.invalid"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service"
  let role = "operador"
  const claims = mock.method(AuthClient.prototype, "getClaims", async () => ({ data: { claims: { sub: "actor" } }, error: null }))
  const requests: string[] = []
  const fetchMock = mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname
    requests.push(path)
    assert.equal(path, "/rest/v1/profiles")
    return Response.json({ id: "actor", rol: role })
  })
  try {
    const history = await import("../../app/api/admin/facturacion/history/route")
    const exportRoute = await import("../../app/api/admin/facturacion/export/route")
    const request = (method: string, token = true) => new Request("http://localhost/api/admin/facturacion/history?kind=invoice", {
      method,
      headers: token ? { Authorization: "Bearer test", "Content-Type": "application/json" } : {},
      body: method === "POST" ? JSON.stringify({ kind: "invoice", scope: "selected", ids: ["18"] }) : undefined,
    })
    assert.equal((await history.GET(request("GET", false))).status, 401)
    assert.equal((await exportRoute.POST(request("POST", false))).status, 401)
    for (role of ["cliente", "operador"]) {
      assert.equal((await history.GET(request("GET"))).status, 403)
      assert.equal((await exportRoute.POST(request("POST"))).status, 403)
    }
    assert.deepEqual(requests, Array(4).fill("/rest/v1/profiles"))
  } finally {
    claims.mock.restore(); fetchMock.mock.restore()
    if (previousUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL
    else process.env.NEXT_PUBLIC_SUPABASE_URL = previousUrl
    if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY
    else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey
  }
})

test("la ruta de cliente conserva la verificación de propiedad del pedido", () => {
  const source = readFileSync("app/api/orders/[id]/invoice/route.ts", "utf8")
  assert.match(source, /\.eq\("usuario_id", user\.id\)/)
  assert.match(source, /\.eq\("id", orderId\)/)
  assert.match(source, /\.is\("usuario_id", null\)/)
  assert.match(source, /escapeIlikeValue\(normalizedEmail\)/)
})

test("ZIP valida comprobantes autorizados y rechaza un mes sobre el límite antes de generar PDFs", async () => {
  const previousUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fiscal-export-test.invalid"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service"
  const claims = mock.method(AuthClient.prototype, "getClaims", async () => ({ data: { claims: { sub: "actor" } }, error: null }))
  const paths: string[] = []
  const fetchMock = mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = new URL(String(input))
    paths.push(url.pathname)
    if (url.pathname === "/rest/v1/profiles") return Response.json({ id: "actor", rol: "admin" })
    if (url.pathname === "/rest/v1/ordenes") {
      assert.equal(url.searchParams.get("invoice_status"), "eq.authorized")
      assert.equal(url.searchParams.get("invoice_cae"), "not.is.null")
      return Response.json([])
    }
    if (url.pathname === "/rest/v1/rpc/search_admin_fiscal_history") return Response.json({ total: 251, items: [] })
    throw new Error(`Consulta inesperada: ${url.pathname}`)
  })
  try {
    const { POST } = await import("../../app/api/admin/facturacion/export/route")
    const request = (body: object) => new Request("http://localhost/api/admin/facturacion/export", {
      method: "POST", headers: { Authorization: "Bearer test", "Content-Type": "application/json" }, body: JSON.stringify(body),
    })
    assert.equal((await POST(request({ kind: "invoice", scope: "selected", ids: ["18"] }))).status, 409)
    assert.equal((await POST(request({ kind: "invoice", scope: "month", year: 2026, month: 10 }))).status, 413)
    assert.deepEqual(paths, ["/rest/v1/profiles", "/rest/v1/ordenes", "/rest/v1/profiles", "/rest/v1/rpc/search_admin_fiscal_history"])
  } finally {
    claims.mock.restore(); fetchMock.mock.restore()
    if (previousUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL
    else process.env.NEXT_PUBLIC_SUPABASE_URL = previousUrl
    if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY
    else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey
  }
})
