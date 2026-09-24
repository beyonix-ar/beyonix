import assert from "node:assert/strict"
import test, { mock } from "node:test"
import { AuthClient } from "@supabase/supabase-js"

test("cambio: PATCH real devuelve 409 sin consultar destinatario ni enviar email cuando la RPC rechaza", async () => {
  const previousEnv = { ...process.env }
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://replacement-test.invalid"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service"
  process.env.RESEND_API_KEY = "test-email"
  process.env.STORE_EMAIL_FROM = "test@example.test"
  const claims = mock.method(AuthClient.prototype, "getClaims", async () => ({ data: { claims: { sub: "actor" } }, error: null }))
  const requests: string[] = []
  const fetchMock = mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    requests.push(path)
    if (path === "/rest/v1/profiles") return Response.json({ id: "actor", rol: "admin" })
    if (path === "/rest/v1/rpc/mutate_admin_order_claim") {
      const body = JSON.parse(String(init?.body))
      assert.equal(body.p_patch.status, "cerrado")
      return Response.json({ message: "CLAIM_REPLACEMENT_REQUIRED", code: "P0001" }, { status: 400 })
    }
    throw new Error(`No debería continuar después del rechazo: ${path}`)
  })
  try {
    const { PATCH } = await import("../../app/api/admin/order-claims/[claimId]/route")
    const response = await PATCH(new Request("http://localhost/api/admin/order-claims/1", {
      method: "PATCH", headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
      body: JSON.stringify({ status: "cerrado", resolution: "cambio_producto", expectedUpdatedAt: "2026-09-24T12:00:00Z", append_message: true, admin_response: "Resuelto" }),
    }), { params: Promise.resolve({ claimId: "1" }) })
    assert.equal(response.status, 409)
    assert.match((await response.json()).error, /Primero registrá un reemplazo/)
    assert.deepEqual(requests, ["/rest/v1/profiles", "/rest/v1/rpc/mutate_admin_order_claim"])
  } finally {
    claims.mock.restore(); fetchMock.mock.restore()
    for (const key of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "RESEND_API_KEY", "STORE_EMAIL_FROM"]) {
      if (previousEnv[key] === undefined) delete process.env[key]; else process.env[key] = previousEnv[key]
    }
  }
})

test("cierre operativo: las rutas reales rechazan al operador antes de acceder a datos", async () => {
  const previousEnv = { ...process.env }
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://roles-test.invalid"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service"
  let role = "operador"
  const claims = mock.method(AuthClient.prototype, "getClaims", async () => ({ data: { claims: { sub: "actor" } }, error: null }))
  const fetchMock = mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    assert.match(String(input), /roles-test\.invalid\/rest\/v1\/profiles\?/)
    return Response.json({ id: "actor", rol: role })
  })
  try {
    const product = await import("../../app/api/admin/products/[id]/route")
    const variant = await import("../../app/api/admin/products/[id]/variants/[variantId]/route")
    const sales = await import("../../app/api/admin/sales-ledger/route")
    const returns = await import("../../app/api/admin/pedidos/[id]/return-inventory/[itemId]/route")
    const replacements = await import("../../app/api/admin/pedidos/[id]/replacements/route")
    const settings = await import("../../app/api/admin/settings/route")
    const destructive = await import("../../app/api/admin/destructive-operations/route")
    const request = (method: string, body = "{}") => new Request("http://localhost/api/admin/test", { method, headers: { Authorization: "Bearer role-test" }, body })
    const params = { params: Promise.resolve({ id: "-1", variantId: "-1", itemId: "-1" }) }
    const checks = [
      () => product.PATCH(request("PATCH"), params),
      () => variant.PATCH(request("PATCH"), params),
      () => sales.POST(request("POST")),
      () => returns.PATCH(request("PATCH"), params),
      () => replacements.POST(request("POST"), params),
      () => settings.PATCH(request("PATCH", "{")),
    ]
    for (const nextRole of ["operador", "admin", "super_admin"]) {
      role = nextRole
      for (const check of checks) assert.equal((await check()).status, role === "operador" ? 403 : 400, role)
      assert.equal((await destructive.POST(request("POST"))).status, role === "super_admin" ? 400 : 403, role)
    }
  } finally {
    claims.mock.restore(); fetchMock.mock.restore()
    for (const key of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
      if (previousEnv[key] === undefined) delete process.env[key]; else process.env[key] = previousEnv[key]
    }
  }
})
