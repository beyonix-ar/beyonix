import assert from "node:assert/strict"
import test, { mock } from "node:test"
import { AuthClient } from "@supabase/supabase-js"

// Rutas agregadas en el último desarrollo: alta de producto (saneado
// server-side), edición, armado aleatorio y conciliación Andreani.
type Call = { path: string; body: Record<string, unknown> | null; authorization: string | null }

async function withRoutes(role: string | null, run: (calls: Call[], responders: Map<string, (body: Record<string, unknown> | null) => Response>) => Promise<void>) {
  const previousEnv = { ...process.env }
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://new-routes.invalid"
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service"
  const calls: Call[] = []
  const responders = new Map<string, (body: Record<string, unknown> | null) => Response>()
  const claims = mock.method(AuthClient.prototype, "getClaims", async () => (
    role === null ? { data: null, error: new Error("invalid") } : { data: { claims: { sub: "actor" } }, error: null }))
  const fetchMock = mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const headers = new Headers(init?.headers)
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null
    calls.push({ path: url.pathname, body, authorization: headers.get("authorization") })
    if (url.pathname === "/rest/v1/profiles") return Response.json({ id: "actor", email: null, rol: role })
    const responder = responders.get(url.pathname)
    if (responder) return responder(body)
    return Response.json([])
  })
  try {
    await run(calls, responders)
  } finally {
    claims.mock.restore(); fetchMock.mock.restore()
    for (const key of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"]) {
      if (previousEnv[key] === undefined) delete process.env[key]; else process.env[key] = previousEnv[key]
    }
  }
}

const request = (method: string, body?: unknown, token: string | null = "user-token") => new Request("http://localhost/api/admin/test", {
  method,
  headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
  body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
})

test("permisos: anon 401, cliente y operador 403 en rutas administrativas nuevas; Admin pasa", async () => {
  const products = await import("../../app/api/admin/products/route")
  const billing = await import("../../app/api/admin/logistics/billing/route")
  const checks = [
    () => products.POST(request("POST", "{")),
    () => billing.POST(request("POST", "{")),
    () => billing.PATCH(request("PATCH", "{")),
    () => billing.GET(new Request("http://localhost/api/admin/logistics/billing?orderId=x", { headers: { Authorization: "Bearer user-token" } })),
  ]
  await withRoutes(null, async () => {
    assert.equal((await products.POST(request("POST", {}, null))).status, 401, "sin token")
    for (const check of checks) assert.equal((await check()).status, 401, "token inválido")
  })
  for (const role of ["cliente", "operador", "admin", "super_admin"]) {
    await withRoutes(role, async (calls) => {
      for (const check of checks) assert.equal((await check()).status, role === "admin" || role === "super_admin" ? 400 : 403, role)
      assert.ok(calls.every((call) => call.path === "/rest/v1/profiles"), "un rechazo nunca toca datos")
    })
  }
})

test("alta de producto: la descripción se sanea en el servidor y la RPC corre con la sesión del Admin", async () => {
  const { POST } = await import("../../app/api/admin/products/route")
  await withRoutes("admin", async (calls, responders) => {
    responders.set("/rest/v1/rpc/create_producto_completo_v2", (body) => Response.json({ id: 9, descripcion: (body?.p_producto as { descripcion: unknown }).descripcion }))
    const cases: Array<[unknown, unknown]> = [
      ["<p onclick=\"alert(1)\">Hola</p><script>alert(1)</script><img src=x onerror=alert(1)>", "<p>Hola</p>"],
      ["Texto simple\n\nSegundo párrafo ñ", "<p>Texto simple</p><p>Segundo párrafo ñ</p>"],
      ["<h2>Título</h2><p><b>Negrita</b></p>", "<h2>Título</h2><p><strong>Negrita</strong></p>"],
      ["", null],
      [null, null],
    ]
    for (const [descripcion, expected] of cases) {
      const response = await POST(request("POST", { producto: { nombre: "X", descripcion, stock: 99 }, variantes: [], imagenes: [], especificaciones: [] }))
      assert.equal(response.status, 201)
      const rpc = calls.filter((call) => call.path === "/rest/v1/rpc/create_producto_completo_v2").at(-1)!
      assert.equal((rpc.body?.p_producto as Record<string, unknown>).descripcion, expected)
      assert.equal("stock" in (rpc.body?.p_producto as Record<string, unknown>), false, "el stock nunca se carga en el alta")
      assert.equal(rpc.authorization, "Bearer user-token", "auth.uid() del Admin, no service_role")
    }
    for (const invalid of [{ producto: { descripcion: { html: "x" } } }, { producto: {}, variantes: "x" }, { producto: {}, variantes: Array.from({ length: 101 }, () => ({})) }]) {
      assert.equal((await POST(request("POST", invalid))).status, 400)
    }
    responders.set("/rest/v1/rpc/create_producto_completo_v2", () => Response.json({ message: "duplicate key value violates unique constraint \"productos_slug_key\"", code: "23505" }, { status: 409 }))
    const duplicate = await POST(request("POST", { producto: { nombre: "X" } }))
    assert.deepEqual([duplicate.status, (await duplicate.json()).code], [409, "23505"])
    responders.set("/rest/v1/rpc/create_producto_completo_v2", () => Response.json({ message: "permission denied for table secret_stuff", code: "42501" }, { status: 403 }))
    const generic = await POST(request("POST", { producto: { nombre: "X" } }))
    assert.deepEqual([generic.status, (await generic.json()).error], [500, "No se pudo crear el producto."], "error técnico sanitizado")
  })
})

test("edición de producto: la descripción se vuelve a sanear y un tipo inválido se rechaza", async () => {
  const { PATCH } = await import("../../app/api/admin/products/[id]/catalog/route")
  await withRoutes("admin", async (calls, responders) => {
    responders.set("/rest/v1/rpc/update_product_commercial_configuration_with_pricing_atomic", () => Response.json({ product: { id: 5 } }))
    const catalog = { nombre: "X", peso_empaquetado_kg: 1, alto_paquete_cm: 1, ancho_paquete_cm: 1, largo_paquete_cm: 1 }
    const params = { params: Promise.resolve({ id: "5" }) }
    const ok = await PATCH(request("PATCH", { catalog: { ...catalog, descripcion: "<p style=\"color:red\" onmouseover=x>Hola <i>mundo</i></p>" }, variantStates: [] }), params)
    assert.equal(ok.status, 200)
    const rpc = calls.find((call) => call.path.endsWith("update_product_commercial_configuration_with_pricing_atomic"))!
    assert.equal((rpc.body?.p_catalog as Record<string, unknown>).descripcion, "<p>Hola <em>mundo</em></p>")
    const bad = await PATCH(request("PATCH", { catalog: { ...catalog, descripcion: ["<p>x</p>"] }, variantStates: [] }), params)
    assert.equal(bad.status, 400)
  })
})

test("armado: variantId se valida y llega a la RPC; el operador puede armar", async () => {
  const { POST } = await import("../../app/api/admin/dispatch/orders/[id]/route")
  const params = { params: Promise.resolve({ id: "40" }) }
  const key = "50000000-0000-4000-8000-000000000001"
  await withRoutes("operador", async (calls, responders) => {
    responders.set("/rest/v1/rpc/scan_order_preparation_code", () => Response.json({ requiresVariant: true, productId: 4, productName: "Encendedor", candidates: [], status: "preparing" }))
    for (const variantId of [0, -1, 1.5, "abc"]) {
      assert.equal((await POST(request("POST", { action: "scan", code: "ENC", requestKey: key, variantId }), params)).status, 400, String(variantId))
    }
    await POST(request("POST", { action: "scan", code: "ENC", requestKey: key, variantId: 43 }), params)
    const rpc = calls.find((call) => call.path === "/rest/v1/rpc/scan_order_preparation_code")!
    assert.deepEqual([rpc.body?.p_variant_id, rpc.body?.p_code, rpc.authorization], [43, "ENC", "Bearer test-service"])
  })
})

test("conciliación: alta manual y PATCH validan entrada antes de la base; errores técnicos no se exponen", async () => {
  const billing = await import("../../app/api/admin/logistics/billing/route")
  await withRoutes("admin", async (calls, responders) => {
    responders.set("/rest/v1/rpc/record_andreani_billing_entries", () => Response.json([{ index: 0, status: "created", entryId: 1, orderId: 24, matchStatus: "matched", movementType: "outbound" }]))
    const created = await billing.POST(request("POST", { action: "manual", orderId: 24, amount: "8.500,00", billedOn: "08/10/2026", reference: "A-1", tracking: " 3600 0001 " }))
    assert.equal(created.status, 201)
    const rpc = calls.find((call) => call.path === "/rest/v1/rpc/record_andreani_billing_entries")!
    assert.deepEqual(rpc.body?.p_entries, [{ orderId: 24, tracking: "36000001", amount: "8500.00", billedOn: "2026-10-08", reference: "A-1", notes: null }])
    assert.deepEqual([rpc.body?.p_source, rpc.body?.p_actor_id], ["manual", "actor"])
    for (const invalid of [{ action: "manual", orderId: 24, amount: "-1", billedOn: "2026-10-08", reference: "A" },
      { action: "manual", orderId: 24, amount: "1", billedOn: "2026-02-30", reference: "A" },
      { action: "manual", orderId: 24, amount: "1", billedOn: "2026-10-08", reference: "" },
      { action: "manual", orderId: 24, amount: "1", billedOn: "2026-10-08", reference: "A", movementType: "gratis" },
      { action: "import", csv: 5, mapping: {} },
      { action: "import", csv: "a,b\n1,2", mapping: { amount: "a", inyectado: "b" } }]) {
      assert.equal((await billing.POST(request("POST", invalid))).status, 400, JSON.stringify(invalid))
    }
    assert.equal((await billing.POST(request("POST", "x".repeat(1_100_000)))).status, 413)
    assert.equal((await billing.PATCH(request("PATCH", { entryId: 1, reason: "abc", patch: { amount: "1" } }))).status, 400, "motivo obligatorio")
    responders.set("/rest/v1/rpc/update_andreani_billing_entry", () => Response.json({ message: "BILLING_DUPLICATE", code: "P0001" }, { status: 400 }))
    const duplicate = await billing.PATCH(request("PATCH", { entryId: 1, reason: "Corrijo referencia", patch: { reference: "A-2" } }))
    assert.deepEqual([duplicate.status, (await duplicate.json()).error], [409, "Ya existe un cargo con esa referencia, tracking y tipo."])
    responders.set("/rest/v1/rpc/record_andreani_billing_entries", () => Response.json({ message: "relation \"x\" does not exist", code: "42P01" }, { status: 400 }))
    const failed = await billing.POST(request("POST", { action: "manual", orderId: 24, amount: "1", billedOn: "2026-10-08", reference: "A" }))
    assert.deepEqual([failed.status, (await failed.json()).error], [500, "No se pudo registrar la facturación."])
  })
})
