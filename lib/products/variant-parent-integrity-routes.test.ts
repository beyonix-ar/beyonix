import assert from "node:assert/strict"
import test, { mock } from "node:test"
import { AuthClient } from "@supabase/supabase-js"

import {
  VARIANT_CREATION_RULE_MESSAGE,
  purchaseProductFromSearch,
  purchaseUrlForProduct,
} from "./variant-creation-rule.ts"

// Rutas reales de variantes / ficha / Compras con PostgREST simulado por
// fetch. Regla: una operación de variante sólo escribe la variante (nunca
// /rest/v1/productos ni el guardado comercial del padre), el alta libre desde
// Productos está bloqueada y el guardado de la ficha viaja con su revisión.

type Call = { path: string; method: string; body: unknown }
type Handler = (url: URL, init?: RequestInit) => Response | undefined

async function withSupabase(handler: Handler, run: (calls: Call[]) => Promise<void>) {
  const previousEnv = { ...process.env }
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://variant-integrity.invalid"
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

const request = (path: string, method: string, body?: unknown) =>
  new Request(`http://localhost${path}`, {
    method,
    headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

const touchesParent = (calls: Call[]) =>
  calls.filter((call) =>
    (call.path === "/rest/v1/productos" && call.method !== "GET") ||
    /update_product_catalog|update_product_commercial|merge_catalog_products/.test(call.path),
  )

test("helpers de la regla: Ir a Compras lleva al ingreso con el producto preseleccionado", () => {
  assert.equal(purchaseUrlForProduct(12), "/admin/compras?producto=12")
  assert.equal(purchaseUrlForProduct(null), "/admin/compras")
  assert.equal(purchaseProductFromSearch("?producto=12"), 12)
  assert.equal(purchaseProductFromSearch("?producto=abc"), null)
  assert.equal(purchaseProductFromSearch("?producto=-3"), null)
  assert.equal(purchaseProductFromSearch(""), null)
})

test("Productos: el alta libre de variante está bloqueada server-side y no escribe nada", async () => {
  const route = await import("../../app/api/admin/products/[id]/variants/route")
  await withSupabase(() => undefined, async (calls) => {
    const response = await route.POST(
      request("/api/admin/products/12/variants", "POST", { color: "#E18579", sku: "ALEGR01", quantity: 0, images: [] }),
      { params: Promise.resolve({ id: "12" }) },
    )
    assert.equal(response.status, 409)
    const body = await response.json() as { error: string; purchaseUrl: string; code: string }
    assert.equal(body.error, VARIANT_CREATION_RULE_MESSAGE)
    assert.equal(body.purchaseUrl, "/admin/compras?producto=12")
    assert.equal(body.code, "variant_creation_requires_purchase")
    assert.deepEqual(calls, [], "ni RPC de alta ni lecturas/escrituras del padre")
  })
})

test("Editar una variante existente sólo envía campos de variante y nunca toca el padre", async () => {
  const route = await import("../../app/api/admin/products/[id]/variants/[variantId]/route")
  await withSupabase((url) => {
    if (url.pathname === "/rest/v1/catalog_sku_registry") return Response.json([])
    if (url.pathname === "/rest/v1/rpc/update_product_variant_metadata_atomic") {
      return Response.json({ id: 6, producto_id: 12, nombre: "CELESTE", sku: "ALEGA02", color_hex: "#C2D8EB" })
    }
    return undefined
  }, async (calls) => {
    const params = { params: Promise.resolve({ id: "12", variantId: "6" }) }
    const ok = await route.PATCH(
      request("/api/admin/products/12/variants/6", "PATCH", { metadata: { nombre: "CELESTE", sku: "ALEGA02", color_hex: "#C2D8EB" } }),
      params,
    )
    assert.equal(ok.status, 200)
    const rpc = calls.find((call) => call.path === "/rest/v1/rpc/update_product_variant_metadata_atomic")
    assert.ok(rpc)
    const metadata = (rpc.body as { p_metadata: Record<string, unknown> }).p_metadata
    assert.deepEqual(Object.keys(metadata).sort(), ["color_hex", "nombre", "sku"])
    assert.deepEqual(touchesParent(calls), [])

    // Un campo del padre colado en la edición de variante se rechaza entero.
    calls.length = 0
    const rejected = await route.PATCH(
      request("/api/admin/products/12/variants/6", "PATCH", { metadata: { nombre: "CELESTE", precio: 0, descripcion: "" } }),
      params,
    )
    assert.equal(rejected.status, 400)
    assert.deepEqual(calls, [], "ninguna escritura")
  })
})

test("Borrar variante: archivada si tiene historial, eliminada si no; cada baja es una sola RPC atómica", async () => {
  const route = await import("../../app/api/admin/products/[id]/variants/[variantId]/route")
  const modes: Array<{ mode: string; reasons: string[] }> = [
    { mode: "archived", reasons: ["tiene compras registradas", "tiene stock"] },
    { mode: "deleted", reasons: [] },
  ]
  await withSupabase((url) => {
    if (url.pathname === "/rest/v1/rpc/delete_or_archive_product_variant") {
      const next = modes.shift()
      return next ? Response.json({ ...next, variant: { id: 6, activo: false } }) : Response.json({ message: "La variante ya no existe." }, { status: 400 })
    }
    return undefined
  }, async (calls) => {
    const params = () => ({ params: Promise.resolve({ id: "12", variantId: "6" }) })
    const archived = await route.DELETE(request("/api/admin/products/12/variants/6", "DELETE"), params())
    assert.equal(archived.status, 200)
    const archivedBody = await archived.json() as { mode: string; message: string; reasons: string[] }
    assert.equal(archivedBody.mode, "archived")
    assert.match(archivedBody.message, /se archivó.*tiene compras registradas/)

    const deleted = await route.DELETE(request("/api/admin/products/12/variants/6", "DELETE"), params())
    assert.equal(((await deleted.json()) as { mode: string }).mode, "deleted")

    assert.deepEqual(calls.map((call) => call.path), [
      "/rest/v1/rpc/delete_or_archive_product_variant",
      "/rest/v1/rpc/delete_or_archive_product_variant",
    ], "sin DELETE directo sobre producto_variantes ni escrituras del padre")
    assert.deepEqual(calls[0].body, { p_product_id: 12, p_variant_id: 6, p_actor_id: "actor" })
  })
})

const catalogBody = (expectedRevision?: number) => ({
  catalog: {
    nombre: "AURICULAR INALAMBRICO LEGATUS",
    slug: "auricular-legatus",
    descripcion: "<p>Descripción</p>",
    precio: 21900,
    activo: false,
    destacado: true,
    categoria_id: 2,
    pricing_mode: "manual",
    peso_empaquetado_kg: 0.32,
    alto_paquete_cm: 9,
    ancho_paquete_cm: 19,
    largo_paquete_cm: 21,
  },
  primarySku: "ALEGA01",
  variantStates: [{ id: 6, active: true }],
  ...(expectedRevision === undefined ? {} : { expectedRevision }),
})

test("Guardar la ficha con datos viejos (otra pestaña / respuesta vieja) se rechaza con 409", async () => {
  const route = await import("../../app/api/admin/products/[id]/catalog/route")
  let conflict = true
  await withSupabase((url) => {
    if (url.pathname === "/rest/v1/rpc/update_product_commercial_configuration_checked") {
      return conflict
        ? Response.json({ code: "40001", message: "El producto cambió desde que abriste el editor (otra pestaña, otro usuario o un evento comercial). Recargalo antes de guardar para no pisar esos cambios." }, { status: 400 })
        : Response.json({ product: { id: 12, catalog_revision: 8 }, variants: [] })
    }
    return undefined
  }, async (calls) => {
    const params = () => ({ params: Promise.resolve({ id: "12" }) })
    const stale = await route.PATCH(request("/api/admin/products/12/catalog", "PATCH", catalogBody(6)), params())
    assert.equal(stale.status, 409)
    const staleBody = await stale.json() as { code: string; error: string }
    assert.equal(staleBody.code, "product_revision_conflict")
    assert.match(staleBody.error, /cambió desde que abriste el editor/)
    assert.deepEqual(calls.map((call) => call.path), ["/rest/v1/rpc/update_product_commercial_configuration_checked"], "no reintenta sin control")
    assert.equal((calls[0].body as { p_expected_revision: number }).p_expected_revision, 6)

    conflict = false
    calls.length = 0
    const fresh = await route.PATCH(request("/api/admin/products/12/catalog", "PATCH", catalogBody(7)), params())
    assert.equal(fresh.status, 200)
    assert.equal(((await fresh.json()) as { product: { catalog_revision: number } }).product.catalog_revision, 8)

    // Promoción activa: el editor nunca escribe (ni borra) el bloqueo del evento.
    calls.length = 0
    const withPromo = catalogBody(8)
    const promoResponse = await route.PATCH(request("/api/admin/products/12/catalog", "PATCH", {
      ...withPromo,
      catalog: { ...withPromo.catalog, promo_event_id: null, promo_original_precio: null, promo_original_precio_anterior: null, promo_original_descuento: null },
    }), params())
    assert.equal(promoResponse.status, 200)
    const sentCatalog = (calls[0].body as { p_catalog: Record<string, unknown> }).p_catalog
    assert.deepEqual(Object.keys(sentCatalog).filter((key) => key.startsWith("promo_")), [], "sin promo_* en null")
    calls.length = 0
    const invalid = await route.PATCH(request("/api/admin/products/12/catalog", "PATCH", { ...catalogBody(), expectedRevision: "7" }), params())
    assert.equal(invalid.status, 400)
    assert.deepEqual(calls, [])
  })
})

const purchaseRequest = (body: Record<string, unknown>, key = "purchase:route-0001") =>
  new Request("http://localhost/api/admin/costs", {
    method: "POST",
    headers: { Authorization: "Bearer test", "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify(body),
  })

const purchaseFields = {
  kind: "product",
  purchaseDate: "2026-10-15",
  quantity: 2,
  receivedQuantity: 2,
  receptionStatus: "recibida",
  unitCost: 8852,
  freightCost: 0,
  supplier: "OKEYROSARIO",
  sku: "ALEGRO01",
}

test("Compras: variante nueva + compra viajan en UNA sola RPC idempotente", async () => {
  const route = await import("../../app/api/admin/costs/route")
  let mode: "ok" | "replay" | "fail" = "ok"
  await withSupabase((url, init) => {
    if (url.pathname === "/rest/v1/rpc/create_variant_and_purchase") {
      if (mode === "fail") {
        return Response.json({ code: "P0001", message: "El código 7796350519950 ya pertenece a otra variante." }, { status: 400 })
      }
      return Response.json({ replayed: mode === "replay", productId: 12, variantId: 13, purchase: { id: "p-1", variant_id: 13 }, variant: { id: 13 } })
    }
    if ((url.pathname === "/rest/v1/productos" || url.pathname === "/rest/v1/mercadolibre_sales") && (init?.method ?? "GET") === "GET") {
      return Response.json([])
    }
    return undefined
  }, async (calls) => {
    const body = {
      ...purchaseFields,
      newVariant: { productId: 12, colorHex: "#eca2a2", colorName: "rosa", sku: "ALEGRO01", barcode: "7790000000001", generateBarcode: false },
    }
    const created = await route.POST(purchaseRequest(body))
    assert.equal(created.status, 201)
    const createdBody = await created.json() as { productId: number; variantId: number; replayed: boolean }
    assert.deepEqual([createdBody.productId, createdBody.variantId, createdBody.replayed], [12, 13, false])
    const rpcCalls = calls.filter((call) => call.path.startsWith("/rest/v1/rpc/"))
    assert.deepEqual(rpcCalls.map((call) => call.path), ["/rest/v1/rpc/create_variant_and_purchase"], "ni alta previa ni compra por separado")
    const args = rpcCalls[0].body as { p_product_id: number; p_variant: Record<string, unknown>; p_purchase: Record<string, unknown>; p_idempotency_key: string }
    assert.equal(args.p_product_id, 12)
    assert.equal(args.p_idempotency_key, "purchase:route-0001")
    assert.deepEqual(args.p_variant, { name: "ROSA", sku: "ALEGRO01", color_hex: "#ECA2A2", barcode: "7790000000001", generate_barcode: false })
    assert.equal(args.p_purchase.unit_cost, 8852)
    assert.equal("product_id" in args.p_purchase, false, "el producto/variante los resuelve la transacción")
    assert.deepEqual(touchesParent(calls), [])

    // Reintento tras timeout / respuesta perdida: misma clave → misma operación.
    mode = "replay"
    calls.length = 0
    const replayed = await route.POST(purchaseRequest(body))
    assert.equal(replayed.status, 200)
    assert.equal(((await replayed.json()) as { replayed: boolean; variantId: number }).variantId, 13)

    // Falla (código duplicado): 409 y ninguna otra escritura.
    mode = "fail"
    calls.length = 0
    const failed = await route.POST(purchaseRequest(body, "purchase:route-0002"))
    assert.equal(failed.status, 409)
    assert.match(((await failed.json()) as { error: string }).error, /ya pertenece/)
    assert.deepEqual(calls.map((call) => call.path), ["/rest/v1/rpc/create_variant_and_purchase"])

    // Una variante nueva no puede apuntar a una existente; datos inválidos no llegan a la base.
    calls.length = 0
    for (const invalid of [
      { ...body, productId: 12, variantId: 6 },
      { ...body, newVariant: { ...body.newVariant, colorHex: "rosa" } },
      { ...body, newVariant: { ...body.newVariant, sku: "" } },
      { ...body, newVariant: { ...body.newVariant, generateBarcode: true } },
      { ...body, newVariant: { productId: null, colorHex: "#000000", sku: "X1" } },
    ]) {
      assert.equal((await route.POST(purchaseRequest(invalid, "purchase:route-0003"))).status, 400)
    }
    assert.deepEqual(calls, [])
  })
})

test("Compras: flete vacío = 0 y negro sin nombre se guarda como NEGRO; datos inválidos no llegan a la base (V)", async () => {
  const route = await import("../../app/api/admin/costs/route")
  await withSupabase((url, init) => {
    if (url.pathname === "/rest/v1/rpc/create_variant_and_purchase") {
      return Response.json({ replayed: false, productId: 12, variantId: 14, purchase: { id: "p-3", variant_id: 14 } })
    }
    if (url.pathname === "/rest/v1/rpc/save_product_purchase_atomic") return Response.json({ id: "p-1" })
    if (url.pathname === "/rest/v1/producto_variantes") return Response.json({ id: 6 })
    if ((url.pathname === "/rest/v1/productos" || url.pathname === "/rest/v1/mercadolibre_sales") && (init?.method ?? "GET") === "GET") {
      return Response.json([])
    }
    return undefined
  }, async (calls) => {
    const base = {
      ...purchaseFields,
      quantity: "2",
      unitCost: "8852",
      newVariant: { productId: 12, colorHex: "#000000", colorName: null, sku: "ALEGRO-NEG", barcode: null, generateBarcode: false },
    }
    for (const freightCost of ["", "0", undefined]) {
      calls.length = 0
      const response = await route.POST(purchaseRequest({ ...base, freightCost }, `purchase:freight-${String(freightCost)}`))
      assert.equal(response.status, 201, `flete ${JSON.stringify(freightCost)}`)
      const args = calls.find((call) => call.path === "/rest/v1/rpc/create_variant_and_purchase")!.body as { p_variant: Record<string, unknown>; p_purchase: Record<string, unknown> }
      assert.equal(args.p_purchase.freight_cost, 0, "flete vacío u omitido se guarda como 0")
      assert.deepEqual([args.p_variant.color_hex, args.p_variant.name], ["#000000", "NEGRO"], "negro por defecto = negro real")
    }
    calls.length = 0
    const decimal = await route.POST(purchaseRequest({ ...base, freightCost: "12500.50" }, "purchase:freight-decimal"))
    assert.equal(decimal.status, 201)
    assert.equal((calls.find((call) => call.path === "/rest/v1/rpc/create_variant_and_purchase")!.body as { p_purchase: { freight_cost: number } }).p_purchase.freight_cost, 12500.5)

    calls.length = 0
    const rejected: [Record<string, unknown>, RegExp][] = [
      [{ ...base, freightCost: "-100" }, /Revisá Flete/],
      [{ ...base, freightCost: "abc" }, /Revisá Flete/],
      [{ ...base, freightCost: "Infinity" }, /Revisá Flete/],
      [{ ...base, unitCost: "" }, /^Falta completar Costo unitario\.$/],
      [{ ...base, quantity: "", unitCost: "" }, /^Falta completar Cantidad comprada y Costo unitario\.$/],
      [{ ...base, quantity: "1.5" }, /número entero mayor que cero/],
      [{ ...base, quantity: "abc" }, /número entero mayor que cero/],
      [{ ...base, newVariant: { ...base.newVariant, colorName: "Verde123" } }, /sin números/],
      [{ ...base, newVariant: { ...base.newVariant, sku: "ALEGRO NEG" } }, /El SKU sólo puede/],
      [{ ...base, newVariant: { ...base.newVariant, barcode: "779 000" } }, /El código de barra sólo puede/],
      [{ ...base, documentNumber: "0001$" }, /número de comprobante/],
    ]
    for (const [body, error] of rejected) {
      const response = await route.POST(purchaseRequest(body, "purchase:invalid-0001"))
      assert.equal(response.status, 400, JSON.stringify(body))
      assert.match(((await response.json()) as { error: string }).error, error)
    }
    assert.equal(calls.length, 0, "nada inválido llega a la base")

    // Editar: mismas reglas (flete vacío = 0; negativo rechazado).
    const patch = (body: Record<string, unknown>) => route.PATCH(new Request("http://localhost/api/admin/costs", {
      method: "PATCH",
      headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }))
    const edit = { ...purchaseFields, id: "8b0f1f8e-0000-4000-8000-000000000001", productId: 12, variantId: 6 }
    assert.equal((await patch({ ...edit, freightCost: "-1" })).status, 400)
    assert.equal((await patch({ ...edit, unitCost: "" })).status, 400)
    calls.length = 0
    assert.equal((await patch({ ...edit, freightCost: "" })).status, 200)
    const saved = calls.find((call) => call.path === "/rest/v1/rpc/save_product_purchase_atomic")!.body as { p_purchase: Record<string, unknown> }
    assert.equal(saved.p_purchase.freight_cost, 0)
  })
})

test("Compras: compra de una variante existente sigue por el camino normal, sin crear variantes", async () => {
  const route = await import("../../app/api/admin/costs/route")
  await withSupabase((url, init) => {
    if (url.pathname === "/rest/v1/producto_variantes") return Response.json({ id: 6 })
    if (url.pathname === "/rest/v1/rpc/save_product_purchase_idempotent") return Response.json({ id: "p-2", variant_id: 6 })
    if ((url.pathname === "/rest/v1/productos" || url.pathname === "/rest/v1/mercadolibre_sales") && (init?.method ?? "GET") === "GET") {
      return Response.json([])
    }
    return undefined
  }, async (calls) => {
    const response = await route.POST(purchaseRequest({ ...purchaseFields, productId: 12, variantId: 6, sku: "ALEGA01" }, "purchase:route-0004"))
    assert.equal(response.status, 201)
    const rpcCalls = calls.filter((call) => call.path.startsWith("/rest/v1/rpc/")).map((call) => call.path)
    assert.deepEqual(rpcCalls, ["/rest/v1/rpc/save_product_purchase_idempotent"])
    assert.deepEqual(touchesParent(calls), [])
  })
})

test("Compras: /costs/new-article ya no crea productos ni variantes (sólo completa lo existente)", async () => {
  const route = await import("../../app/api/admin/costs/new-article/route")
  await withSupabase(() => undefined, async (calls) => {
    for (const body of [
      { productId: 12, sku: "ALEGRO01", colorHex: "#ECA2A2", colorName: "ROSA", barcode: "7790000000001" },
      { name: "ARTICULO NUEVO", sku: "NEW01", colorHex: "#000000", colorName: "NEGRO" },
    ]) {
      const response = await route.POST(request("/api/admin/costs/new-article", "POST", body))
      assert.equal(response.status, 409)
      assert.match(((await response.json()) as { error: string }).error, /se crea junto con su compra/)
    }
    assert.deepEqual(calls, [], "ninguna escritura sin compra")
  })
})