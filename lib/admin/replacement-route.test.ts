import assert from "node:assert/strict"
import test, { mock } from "node:test"
import { AuthClient } from "@supabase/supabase-js"

// Ruta real /api/admin/pedidos/[id]/replacements con PostgREST simulado por
// fetch. Regla "mismo producto": el servidor rechaza una variante de otro
// producto antes de llegar a la RPC (que es la que descuenta stock).

type Handler = (url: URL, init?: RequestInit) => Response | undefined

async function withRoute(handler: Handler, run: (route: typeof import("../../app/api/admin/pedidos/[id]/replacements/route"), requests: URL[]) => Promise<void>) {
  const previousEnv = { ...process.env }
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://replacement-route.invalid"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service"
  const requests: URL[] = []
  const claims = mock.method(AuthClient.prototype, "getClaims", async () => ({ data: { claims: { sub: "actor" } }, error: null }))
  const fetchMock = mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    requests.push(url)
    if (url.pathname === "/rest/v1/profiles") return Response.json({ id: "actor", rol: "admin" })
    const response = handler(url, init)
    if (!response) throw new Error(`Request inesperado: ${url.pathname}${url.search}`)
    return response
  })
  try {
    await run(await import("../../app/api/admin/pedidos/[id]/replacements/route"), requests)
  } finally {
    claims.mock.restore(); fetchMock.mock.restore()
    for (const key of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
      if (previousEnv[key] === undefined) delete process.env[key]; else process.env[key] = previousEnv[key]
    }
  }
}

// maybeSingle(): PostgREST responde un objeto (o 406 sin filas) con el Accept de objeto.
const single = (init: RequestInit | undefined, row: Record<string, unknown> | null) => {
  const accept = new Headers(init?.headers).get("Accept") ?? ""
  if (accept.includes("vnd.pgrst.object")) {
    return row ? Response.json(row) : Response.json({ code: "PGRST116", message: "0 rows" }, { status: 406 })
  }
  return Response.json(row ? [row] : [])
}

const post = (body: Record<string, unknown>) => new Request("http://localhost/api/admin/pedidos/500/replacements", {
  method: "POST",
  headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
  body: JSON.stringify({ orderItemId: 71, quantity: 1, reason: "otra_variante", notes: "Falla de fábrica", idempotencyKey: "replacement-key-1", ...body }),
})
const params = { params: Promise.resolve({ id: "500" }) }

const catalog: Record<number, number> = { 9: 1, 10: 1, 20: 2 }
const postgrest: Handler = (url, init) => {
  if (url.pathname === "/rest/v1/orden_items") {
    return single(init, url.searchParams.get("id") === "eq.71" && url.searchParams.get("orden_id") === "eq.500" ? { producto_id: 1 } : null)
  }
  if (url.pathname === "/rest/v1/producto_variantes") {
    const id = Number(url.searchParams.get("id")?.replace("eq.", ""))
    return single(init, catalog[id] ? { producto_id: catalog[id] } : null)
  }
  if (url.pathname === "/rest/v1/rpc/create_order_replacement") return Response.json({ id: 1, quantity: 1 })
  return undefined
}

test("POST: una variante de OTRO producto se rechaza sin llamar a la RPC", async () => {
  await withRoute(postgrest, async (route, requests) => {
    const response = await route.POST(post({ replacementVariantId: 20 }), params)
    assert.equal(response.status, 400)
    assert.match((await response.json()).error, /mismo producto reclamado/)
    assert.ok(!requests.some((url) => url.pathname.includes("/rpc/")), "no descuenta stock")
  })
})

test("POST: reason otro_producto ya no se acepta", async () => {
  await withRoute(postgrest, async (route, requests) => {
    const response = await route.POST(post({ replacementVariantId: 10, reason: "otro_producto" }), params)
    assert.equal(response.status, 400)
    assert.ok(!requests.some((url) => url.pathname.includes("/rpc/")))
  })
})

test("POST: variante inexistente o ítem ajeno al pedido se rechazan", async () => {
  await withRoute(postgrest, async (route, requests) => {
    assert.equal((await route.POST(post({ replacementVariantId: 999 }), params)).status, 400)
    assert.equal((await route.POST(post({ replacementVariantId: 10, orderItemId: 72 }), params)).status, 400)
    assert.ok(!requests.some((url) => url.pathname.includes("/rpc/")))
  })
})

test("POST: otra variante del MISMO producto llega a la RPC con el payload intacto", async () => {
  let rpcBody: Record<string, unknown> | null = null
  await withRoute((url, init) => {
    if (url.pathname === "/rest/v1/rpc/create_order_replacement") rpcBody = JSON.parse(String(init?.body))
    return postgrest(url, init)
  }, async (route) => {
    const response = await route.POST(post({ replacementVariantId: 10, claimId: 900 }), params)
    assert.equal(response.status, 200)
  })
  assert.deepEqual(rpcBody, {
    p_original_order_id: 500,
    p_original_order_item_id: 71,
    p_replacement_variant_id: 10,
    p_quantity: 1,
    p_reason: "otra_variante",
    p_actor_id: "actor",
    p_idempotency_key: "replacement-key-1",
    p_condition_note: null,
    p_notes: "Falla de fábrica",
    p_claim_id: 900,
  })
})

test("GET: sólo variantes de los productos del pedido, sin búsqueda global", async () => {
  await withRoute((url) => {
    if (url.pathname === "/rest/v1/order_replacements") return Response.json([{ id: 3, original_order_item_id: 72, reason: "otro_producto", quantity: 1 }])
    if (url.pathname === "/rest/v1/orden_items") return Response.json([{ producto_id: 1 }, { producto_id: 2 }, { producto_id: 1 }])
    if (url.pathname === "/rest/v1/producto_variantes") {
      assert.equal(url.searchParams.get("producto_id"), "in.(1,2)")
      assert.equal(url.searchParams.get("nombre"), null, "sin ilike por nombre")
      return Response.json([{ id: 9, producto_id: 1 }, { id: 20, producto_id: 2 }])
    }
    return undefined
  }, async (route) => {
    const response = await route.GET(new Request("http://localhost/api/admin/pedidos/500/replacements?search=cualquier", { headers: { Authorization: "Bearer test" } }), params)
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.deepEqual(body.variants.map((row: { id: number }) => row.id), [9, 20])
    assert.equal(body.replacements[0].reason, "otro_producto", "el historial previo se sigue devolviendo")
  })
})
