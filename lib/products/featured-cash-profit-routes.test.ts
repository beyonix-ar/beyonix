import assert from "node:assert/strict"
import test, { mock } from "node:test"
import { AuthClient } from "@supabase/supabase-js"

// Rutas reales de Admin → Productos (destacado con posición y ganancia
// estimada al contado) y la consulta real del destacado de Home, con
// Supabase simulado a nivel HTTP.

type Call = { method: string; path: string; search: URLSearchParams; body: Record<string, unknown> | null }
type Responder = (call: Call) => Response

const SUPABASE_URL = "https://featured-routes.invalid"

async function withSupabase(role: string | null, responders: Array<[RegExp, Responder]>, run: (calls: Call[]) => Promise<void>) {
  const previousEnv = { ...process.env }
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service"
  const calls: Call[] = []
  const claims = mock.method(AuthClient.prototype, "getClaims", async () => (
    role === null ? { data: null, error: new Error("invalid") } : { data: { claims: { sub: "actor" } }, error: null }))
  const fetchMock = mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null
    const call = { method: init?.method ?? "GET", path: url.pathname, search: url.searchParams, body }
    calls.push(call)
    if (url.origin !== SUPABASE_URL) return Response.json({ error: "external request not allowed" }, { status: 599 })
    if (url.pathname === "/rest/v1/profiles") return Response.json({ id: "actor", email: null, rol: role })
    const responder = responders.find(([pattern]) => pattern.test(`${url.pathname}?${url.searchParams}`))
    return responder ? responder[1](call) : Response.json([])
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

const request = (method: string, body?: unknown, token: string | null = "user-token") => new Request("http://localhost/api/admin/products/5/x", {
  method,
  headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
})
const params = (id = "5") => ({ params: Promise.resolve({ id }) })

const PROD_FINANCING_ROW = { value: { mode: "automatic", ivaPercent: 21, baseProcessingPercent: 3.46, surchargePercentByCount: { 2: 7.79, 3: 10.49, 6: 18.69 }, interestFreePolicy: { enabled: true } } }

function costResponders(options: { financing?: unknown; variants?: unknown[]; costs?: unknown[]; price?: number; activo?: boolean; stock?: Array<{ id: number; activo: boolean; stock: number }>; reservations?: unknown[] } = {}): Array<[RegExp, Responder]> {
  return [
    [/^\/rest\/v1\/site_settings\?.*key=eq\.installments_financing/, () => Response.json(options.financing === undefined ? [PROD_FINANCING_ROW] : options.financing)],
    [/^\/rest\/v1\/site_settings\?.*key=eq\.pricing/, () => Response.json([{ value: { transferDiscountPercent: 10 } }])],
    [/^\/rest\/v1\/productos\?/, () => Response.json([{
      precio: options.price ?? 30_000,
      stock: 12,
      activo: options.activo ?? true,
      producto_variantes: options.stock ?? [{ id: 11, activo: true, stock: 4 }, { id: 12, activo: true, stock: 6 }, { id: 13, activo: false, stock: 2 }],
    }])],
    [/^\/rest\/v1\/rpc\/active_stock_reservation_totals/, () => Response.json(options.reservations ?? [])],
    [/^\/rest\/v1\/producto_variantes\?/, () => Response.json(options.variants ?? [
      { id: 11, nombre: "NEGRO", activo: true },
      { id: 12, nombre: "ÁMBAR", activo: true },
      { id: 13, nombre: "ROSA", activo: false },
    ])],
    [/^\/rest\/v1\/product_cost_entries\?/, () => Response.json(options.costs ?? [
      { product_id: 5, variant_id: 11, purchase_date: "2026-10-01", quantity: 10, received_quantity: 10, reception_status: "recibida", total_cost: 100_000 },
      { product_id: 5, variant_id: 12, purchase_date: "2026-10-01", quantity: 10, received_quantity: 10, reception_status: "recibida", total_cost: 120_000 },
      { product_id: 5, variant_id: 13, purchase_date: "2026-10-01", quantity: 10, received_quantity: 10, reception_status: "recibida", total_cost: 290_000 },
      // Compra pendiente: no forma costo.
      { product_id: 5, variant_id: 12, purchase_date: "2026-10-20", quantity: 10, received_quantity: 0, reception_status: "pendiente", total_cost: 900_000 },
    ])],
    // Modo automático sin pagos observados: se usa la comisión manual.
    [/^\/rest\/v1\/ordenes\?/, () => Response.json([])],
  ]
}

test("permisos: anon 401, cliente y operador 403; un rechazo nunca toca datos ni costos", async () => {
  const featured = await import("../../app/api/admin/products/[id]/featured/route")
  const cashProfit = await import("../../app/api/admin/products/[id]/cash-profit/route")
  await withSupabase(null, [], async () => {
    assert.equal((await featured.PATCH(request("PATCH", { destacado: true }, null), params())).status, 401)
    assert.equal((await cashProfit.GET(request("GET", undefined, null), params())).status, 401)
    assert.equal((await cashProfit.GET(request("GET"), params())).status, 401, "token inválido")
  })
  for (const role of ["cliente", "operador"]) {
    await withSupabase(role, costResponders(), async (calls) => {
      assert.equal((await featured.PATCH(request("PATCH", { destacado: true, featuredPosition: 1 }), params())).status, 403, role)
      assert.equal((await cashProfit.GET(request("GET"), params())).status, 403, role)
      assert.ok(calls.every((call) => call.path === "/rest/v1/profiles"), "un rechazo nunca toca datos")
    })
  }
})

test("destacado: valida antes de la RPC, pasa la posición y traduce la posición ocupada", async () => {
  const { PATCH } = await import("../../app/api/admin/products/[id]/featured/route")
  let rpcResponse: Response = Response.json({ id: 5, destacado: true, featured_position: 2, catalog_revision: 8 })
  await withSupabase("admin", [[/^\/rest\/v1\/rpc\/set_product_featured_position/, () => rpcResponse.clone()]], async (calls) => {
    for (const invalid of [{ destacado: true, featuredPosition: 0 }, { destacado: false, featuredPosition: 2 }, { destacado: "si" }]) {
      assert.equal((await PATCH(request("PATCH", invalid), params())).status, 400, JSON.stringify(invalid))
    }
    assert.equal((await PATCH(request("PATCH", { destacado: true }), params("abc"))).status, 400)
    assert.ok(!calls.some((call) => call.path.startsWith("/rest/v1/rpc/")), "entrada inválida nunca llega a la base")

    const ok = await PATCH(request("PATCH", { destacado: true, featuredPosition: 2, expectedRevision: 7 }), params())
    assert.equal(ok.status, 200)
    assert.deepEqual(await ok.json(), { destacado: true, featuredPosition: 2, catalogRevision: 8 })
    const rpc = calls.find((call) => call.path === "/rest/v1/rpc/set_product_featured_position")!
    assert.deepEqual(rpc.body, { p_product_id: 5, p_destacado: true, p_position: 2, p_expected_revision: 7 })

    rpcResponse = Response.json({ code: "23505", message: 'La posición 2 ya está ocupada por "TRÍPODE ÑANDÚ".' }, { status: 409 })
    const taken = await PATCH(request("PATCH", { destacado: true, featuredPosition: 2 }), params())
    assert.equal(taken.status, 409)
    assert.deepEqual(await taken.json(), { error: 'La posición 2 ya está ocupada por "TRÍPODE ÑANDÚ".', code: "featured_position_taken" })

    rpcResponse = Response.json({ code: "PGRST202", message: "Could not find the function public.set_product_featured_position" }, { status: 404 })
    assert.equal((await PATCH(request("PATCH", { destacado: false }), params())).status, 503, "migración sin aplicar")
  })
})

test("ganancia al contado: rango por variante vendible, consultas constantes y sin requests a Mercado Pago", async () => {
  const { GET } = await import("../../app/api/admin/products/[id]/cash-profit/route")
  await withSupabase("admin", costResponders(), async (calls) => {
    const response = await GET(request("GET"), params())
    assert.equal(response.status, 200)
    const body = await response.json() as Record<string, unknown>
    assert.equal(body.status, "available")
    assert.equal(body.feePercent, 5)
    assert.equal(body.feeSource, "manual")
    // 30.000 × 0,95 − 10.000 = 18.500 (NEGRO); − 12.000 = 16.500 (ÁMBAR); ROSA inactiva fuera.
    assert.equal(body.minProfit, 16_500)
    assert.equal(body.maxProfit, 18_500)
    assert.deepEqual((body.variants as Array<{ variantId: number }>).map((variant) => variant.variantId), [11, 12])

    const dataCalls = calls.filter((call) => call.path !== "/rest/v1/profiles")
    assert.ok(dataCalls.every((call) => call.path.startsWith("/rest/v1/")), "nunca consulta Mercado Pago ni APIs externas")
    // La RPC de reservas activas es de lectura (PostgREST la invoca por POST).
    assert.ok(dataCalls.every((call) => call.method === "GET" || call.path === "/rest/v1/rpc/active_stock_reservation_totals"), "sólo lectura")
    assert.equal(dataCalls.filter((call) => call.path === "/rest/v1/product_cost_entries").length, 1, "un solo libro de compras para todas las variantes")
    assert.equal(dataCalls.filter((call) => call.path === "/rest/v1/producto_variantes").length, 1)
    assert.equal(dataCalls.filter((call) => call.path === "/rest/v1/rpc/active_stock_reservation_totals").length, 1, "stock vendible: una consulta, no una por variante")
    assert.ok(dataCalls.length <= 12, `consultas acotadas (${dataCalls.length})`)
  })
})

test("ganancia al contado: variante activa sin stock vendible (reservas = físico) no entra; todas sin stock → No disponible", async () => {
  const { GET } = await import("../../app/api/admin/products/[id]/cash-profit/route")
  // ÁMBAR tiene 6 físicas pero 6 reservadas: disponible 0 (misma regla que el catálogo).
  const reservations = [{ product_id: 5, variant_id: 12, conditioned_stock_id: null, reserved_quantity: 6 }]
  await withSupabase("admin", costResponders({ reservations }), async (calls) => {
    const body = await (await GET(request("GET"), params())).json() as Record<string, unknown>
    assert.equal(body.status, "available")
    assert.equal(body.minProfit, 18_500)
    assert.equal(body.maxProfit, 18_500, "sólo NEGRO")
    assert.deepEqual((body.variants as Array<{ variantId: number }>).map((variant) => variant.variantId), [11])
    const rpc = calls.find((call) => call.path === "/rest/v1/rpc/active_stock_reservation_totals")
    assert.deepEqual(rpc?.body?.p_product_ids, [5], "una sola consulta de reservas para todo el producto")
  })
  await withSupabase("admin", costResponders({ stock: [{ id: 11, activo: true, stock: 0 }, { id: 12, activo: true, stock: 0 }, { id: 13, activo: false, stock: 9 }] }), async () => {
    const body = await (await GET(request("GET"), params())).json() as Record<string, unknown>
    assert.equal(body.status, "unavailable")
    assert.equal(body.message, "Sin variantes con stock vendible.")
  })
})

// Lecturas posteriores al producto (tarifa, costos/variantes, reservas, pagos MP observados).
const FINANCIAL_PATHS = /^\/rest\/v1\/(site_settings|product_cost_entries|producto_variantes|ordenes|rpc\/active_stock_reservation_totals)/
const failing = (pattern: RegExp): [RegExp, Responder] => [pattern, () => Response.json({ code: "XX000", message: "boom" }, { status: 500 })]
const INACTIVE = { status: "unavailable", reason: "product_inactive", message: "Producto inactivo." }

for (const [label, broken] of [
  ["A: tarifa MP rota", failing(/^\/rest\/v1\/site_settings\?/)],
  ["B: costos rotos", failing(/^\/rest\/v1\/product_cost_entries\?/)],
  ["C: reservas rotas", failing(/^\/rest\/v1\/rpc\/active_stock_reservation_totals/)],
] as const) {
  test(`ganancia al contado: padre inactivo corta antes de leer finanzas (${label})`, async () => {
    const { GET } = await import("../../app/api/admin/products/[id]/cash-profit/route")
    await withSupabase("admin", [broken, ...costResponders({ activo: false })], async (calls) => {
      const response = await GET(request("GET"), params())
      assert.equal(response.status, 200, "respuesta normal, nunca 500")
      assert.deepEqual(await response.json(), INACTIVE)
      assert.deepEqual(calls.filter((call) => FINANCIAL_PATHS.test(call.path)), [], "0 consultas de tarifa, costos ni reservas")
    })
  })
}

test("ganancia al contado: D) padre inactivo con variantes activas, stock y costo → sólo se lee el producto", async () => {
  const { GET } = await import("../../app/api/admin/products/[id]/cash-profit/route")
  await withSupabase("admin", costResponders({ activo: false }), async (calls) => {
    const response = await GET(request("GET"), params())
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), INACTIVE)
    const dataCalls = calls.filter((call) => call.path !== "/rest/v1/profiles")
    assert.deepEqual(dataCalls.map((call) => call.path), ["/rest/v1/productos"], "una sola lectura: el producto")
    assert.match(dataCalls[0].search.get("select") ?? "", /\bactivo\b/, "usa productos.activo real")
  })
})

test("ganancia al contado: E) padre activo mantiene el flujo completo (tarifa, costos, reservas) y el cálculo", async () => {
  const { GET } = await import("../../app/api/admin/products/[id]/cash-profit/route")
  await withSupabase("admin", costResponders({ activo: true }), async (calls) => {
    const body = await (await GET(request("GET"), params())).json() as Record<string, unknown>
    assert.equal(body.status, "available")
    assert.equal(body.minProfit, 16_500)
    assert.equal(body.maxProfit, 18_500)
    for (const path of ["/rest/v1/site_settings", "/rest/v1/product_cost_entries", "/rest/v1/producto_variantes", "/rest/v1/rpc/active_stock_reservation_totals"]) {
      assert.ok(calls.some((call) => call.path === path), `consulta ${path}`)
    }
    assert.equal(calls.filter((call) => call.path === "/rest/v1/productos").length, 1, "el producto se lee una sola vez")
  })
})

test("ganancia al contado: tarifa MP sin configurar → No disponible con motivo", async () => {
  const { GET } = await import("../../app/api/admin/products/[id]/cash-profit/route")
  await withSupabase("admin", costResponders({ financing: [] }), async () => {
    const body = await (await GET(request("GET"), params())).json() as Record<string, unknown>
    assert.equal(body.status, "unavailable")
    assert.equal(body.reason, "fee_unconfigured")
    assert.match(String(body.message), /Falta configurar el costo de Mercado Pago en 1 pago/)
  })
})

test("Home (tarjeta Producto destacado): orden por posición y el primero sin stock se saltea", async () => {
  const product = (id: number, featured_position: number | null, stock: number) => ({
    id, nombre: `P${id}`, slug: `p${id}`, precio: 1000, destacado: true, activo: true, featured_position, stock,
    created_at: "2026-10-01T00:00:00Z", producto_variantes: [], imagenes_producto: [], reviews: [],
  })
  let productQueries: URLSearchParams[] = []
  let failPosition = false
  const responders: Array<[RegExp, Responder]> = [
    [/^\/rest\/v1\/productos\?/, (call) => {
      productQueries.push(call.search)
      if (failPosition && call.search.get("order")?.includes("featured_position")) {
        return Response.json({ code: "42703", message: "column productos.featured_position does not exist" }, { status: 400 })
      }
      return Response.json([product(2, 1, 0), product(1, 2, 5), product(3, null, 5)])
    }],
  ]
  await withSupabase(null, responders, async () => {
    // Crea su cliente al importarse: necesita el entorno simulado.
    const { getFeaturedProduct } = await import("../supabase/queries/store-server")
    const selected = await getFeaturedProduct()
    assert.equal(selected?.id, 1, "posición 1 sin stock vendible no se muestra; sigue la 2")
    assert.equal(productQueries[0].get("order"), "featured_position.asc.nullslast,created_at.desc,id.desc")
    assert.equal(productQueries[0].get("activo"), "eq.true", "inactivos nunca")
    assert.equal(productQueries[0].get("destacado"), "eq.true")

    productQueries = []
    failPosition = true
    assert.equal((await getFeaturedProduct())?.id, 1, "sin la migración Home sigue funcionando")
    assert.equal(productQueries[1].get("order"), "created_at.desc,id.desc")
  })
})

test("Home (sección Productos destacados): mismo orden, sin stock afuera e inactivos nunca", async () => {
  const product = (id: number, featured_position: number | null, stock: number) => ({
    id, nombre: `P${id}`, slug: `p${id}`, precio: 1000, destacado: true, activo: true, featured_position, stock,
    created_at: "2026-10-01T00:00:00Z", producto_variantes: [], imagenes_producto: [],
  })
  const productQueries: URLSearchParams[] = []
  const responders: Array<[RegExp, Responder]> = [
    [/^\/rest\/v1\/productos\?/, (call) => {
      productQueries.push(call.search)
      return Response.json([product(4, 1, 3), product(2, 2, 0), product(1, 3, 2), product(9, null, 1)])
    }],
  ]
  await withSupabase(null, responders, async () => {
    const { getFeaturedProductos } = await import("../supabase/queries/store")
    const products = await getFeaturedProductos()
    assert.deepEqual(products.map((item) => item.id), [4, 1, 9], "respeta el orden de la base y saca el sin stock")
    assert.equal(productQueries[0].get("order"), "featured_position.asc.nullslast,created_at.desc,id.desc")
    assert.equal(productQueries[0].get("activo"), "eq.true")
  })
})
