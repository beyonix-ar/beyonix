import assert from "node:assert/strict"
import test, { mock } from "node:test"
import { AuthClient } from "@supabase/supabase-js"

// Editar compra -> corregir el código de barra de la variante, con la ruta
// real /api/admin/costs/new-article y PostgREST simulado por fetch: sólo se
// toca el código de la variante (RPC atómica con auditoría), un código ajeno
// se bloquea indicando dónde está usado y la compra nueva sigue sin pisarlos.

type Call = { path: string; method: string; body: unknown; query: string }
type Handler = (url: URL, init?: RequestInit) => Response | undefined

const PURCHASE_ID = "de7eb2f4-e135-40e2-9ff4-66f795268d1c"

async function withSupabase(handler: Handler, run: (calls: Call[]) => Promise<void>) {
  const previousEnv = { ...process.env }
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://purchase-barcode.invalid"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service"
  const calls: Call[] = []
  const claims = mock.method(AuthClient.prototype, "getClaims", async () => ({ data: { claims: { sub: "actor" } }, error: null }))
  const fetchMock = mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.pathname === "/rest/v1/profiles") return Response.json({ id: "actor", rol: "admin" })
    calls.push({
      path: url.pathname,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      query: url.search,
    })
    const response = handler(url, init)
    if (!response) throw new Error(`Request inesperado: ${init?.method ?? "GET"} ${url.pathname}${url.search}`)
    return response
  })
  try {
    await run(calls)
  } finally {
    claims.mock.restore()
    fetchMock.mock.restore()
    for (const key of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
      if (previousEnv[key] === undefined) delete process.env[key]
      else process.env[key] = previousEnv[key]
    }
  }
}

const post = (body: Record<string, unknown>) =>
  new Request("http://localhost/api/admin/costs/new-article", {
    method: "POST",
    headers: { Authorization: "Bearer test", "Content-Type": "application/json", "Idempotency-Key": "article:edit-0001" },
    body: JSON.stringify(body),
  })

const editBody = (barcode: string | null, extra: Record<string, unknown> = {}) => ({
  productId: "9", variantId: "15", sku: "AUMR01", barcode, generateBarcode: false,
  replaceBarcode: true, purchaseId: PURCHASE_ID, ...extra,
})

// MALIBU: el proveedor mandó el mismo código para NEGRO (9) y ROSA (15).
function catalog(registry: Record<string, { product_id: number | null; variant_id: number | null }>, aliases: Record<string, { product_id: number }> = {}): Handler {
  return (url) => {
    const code = decodeURIComponent(url.searchParams.get("normalized_barcode")?.replace(/^eq\./, "") ?? "")
    if (url.pathname === "/rest/v1/catalog_barcode_registry") return Response.json(registry[code] ? [registry[code]] : [])
    if (url.pathname === "/rest/v1/catalog_barcode_aliases") return Response.json(aliases[code] ? [aliases[code]] : [])
    if (url.pathname === "/rest/v1/producto_variantes") {
      return Response.json([{ nombre: url.searchParams.get("id") === "eq.9" ? "NEGRO" : "VERDE", productos: { nombre: "AURICULAR INALAMBRICO MALIBU" } }])
    }
    if (url.pathname === "/rest/v1/productos") return Response.json([{ nombre: "AURICULAR INALAMBRICO CZ" }])
    if (url.pathname === "/rest/v1/rpc/update_variant_barcode_from_purchase") {
      return Response.json({ id: 15, producto_id: 9, codigo_barra: "ok" })
    }
    return undefined
  }
}

const touchesPurchaseOrStock = (calls: Call[]) =>
  calls.filter((call) => /product_cost_entries|save_product_purchase|adjust_variant_stock|refresh_inventory|update_product_variant_with_allocation/.test(call.path))

test("código nuevo: una sola RPC atómica con la compra, la variante y el usuario; no toca compra ni stock (B/E/G)", async () => {
  const route = await import("../../app/api/admin/costs/new-article/route")
  await withSupabase(catalog({}), async (calls) => {
    const response = await route.POST(post(editBody("7791234500017")))
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { productId: 9, variantId: 15 })
    const rpc = calls.filter((call) => call.path.startsWith("/rest/v1/rpc/"))
    assert.deepEqual(rpc.map((call) => call.path), ["/rest/v1/rpc/update_variant_barcode_from_purchase"])
    assert.deepEqual(rpc[0].body, {
      p_product_id: 9, p_variant_id: 15, p_purchase_id: PURCHASE_ID, p_barcode: "7791234500017", p_actor_id: "actor",
    })
    assert.deepEqual(touchesPurchaseOrStock(calls), [])
  })
})

test("código que ya usa otra variante: se bloquea y dice en qué producto y variante está (C)", async () => {
  const route = await import("../../app/api/admin/costs/new-article/route")
  await withSupabase(catalog({ "7790001000017": { product_id: null, variant_id: 9 } }), async (calls) => {
    const response = await route.POST(post(editBody("7790001000017")))
    assert.equal(response.status, 409)
    assert.equal(
      ((await response.json()) as { error: string }).error,
      "El código de barra 7790001000017 ya está asignado a AURICULAR INALAMBRICO MALIBU · NEGRO. Usá un código distinto para esta variante.",
    )
    assert.equal(calls.some((call) => call.path.startsWith("/rest/v1/rpc/")), false, "no escribe nada")
  })
})

test("un código de grupo (alias de varios colores) tampoco se puede tomar como código de variante", async () => {
  const route = await import("../../app/api/admin/costs/new-article/route")
  await withSupabase(catalog({}, { "7790000099999": { product_id: 13 } }), async (calls) => {
    const response = await route.POST(post(editBody("7790000099999")))
    assert.equal(response.status, 409)
    assert.match(((await response.json()) as { error: string }).error, /código de grupo de AURICULAR INALAMBRICO CZ/)
    assert.equal(calls.some((call) => call.path.startsWith("/rest/v1/rpc/")), false)
  })
})

test("el código que ya tiene la variante o el del mismo producto no es conflicto (D)", async () => {
  const route = await import("../../app/api/admin/costs/new-article/route")
  await withSupabase(catalog({
    "BX-AUR-000009": { product_id: null, variant_id: 15 },
    "7790000077777": { product_id: 9, variant_id: null },
  }), async (calls) => {
    assert.equal((await route.POST(post(editBody("BX-AUR-000009")))).status, 200)
    assert.equal((await route.POST(post(editBody("7790000077777")))).status, 200)
    // La idempotencia (mismo código = sin cambio ni auditoría) vive en la RPC.
    assert.equal(calls.filter((call) => call.path === "/rest/v1/rpc/update_variant_barcode_from_purchase").length, 2)
  })
})

test("vacío o BEYONIX: viaja como null y la base asigna el código interno", async () => {
  const route = await import("../../app/api/admin/costs/new-article/route")
  await withSupabase(catalog({}), async (calls) => {
    assert.equal((await route.POST(post(editBody(null)))).status, 200)
    assert.equal((await route.POST(post(editBody(null, { generateBarcode: true })))).status, 200)
    const sent = calls.filter((call) => call.path === "/rest/v1/rpc/update_variant_barcode_from_purchase")
    assert.deepEqual(sent.map((call) => (call.body as { p_barcode: unknown }).p_barcode), [null, null])
    assert.equal(calls.some((call) => call.path.includes("catalog_barcode_registry")), false, "sin código no hay nada que chequear")
  })
})

test("reemplazar exige una compra y una variante reales; prefijos reservados siguen rechazados", async () => {
  const route = await import("../../app/api/admin/costs/new-article/route")
  await withSupabase(catalog({}), async (calls) => {
    assert.equal((await route.POST(post(editBody("7791234500017", { purchaseId: "c1" })))).status, 400)
    assert.equal((await route.POST(post(editBody("7791234500017", { variantId: null })))).status, 400)
    assert.equal((await route.POST(post(editBody("BX-PKG-000001")))).status, 400)
    assert.deepEqual(calls, [])
  })
})

test("compra NUEVA (sin replaceBarcode): sigue sin pisar un código existente", async () => {
  const route = await import("../../app/api/admin/costs/new-article/route")
  await withSupabase((url) => {
    if (url.pathname === "/rest/v1/producto_variantes") return Response.json([{ codigo_barra: "BX-AUR-000009" }])
    return undefined
  }, async (calls) => {
    const response = await route.POST(post({ productId: "9", variantId: "15", barcode: "7791234500017", generateBarcode: false }))
    assert.equal(response.status, 409)
    assert.match(((await response.json()) as { error: string }).error, /ya tiene el código BX-AUR-000009/)
    assert.equal(calls.some((call) => call.path.startsWith("/rest/v1/rpc/") || call.method !== "GET"), false)
  })
})
