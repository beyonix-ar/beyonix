import assert from "node:assert/strict"
import test, { mock } from "node:test"
import { AuthClient } from "@supabase/supabase-js"

import {
  buildProductCostLedgers,
  getWorstCaseKnownCost,
  resolveProductVariantCosts,
  resolveTargetMarginCostBasis,
  type ProductCostLedgerRow,
} from "../business/product-costs.ts"
import { selectRelevantVariantCosts } from "../pricing/product-target-margin.ts"

// Guardar ≠ publicar, con las rutas reales y PostgREST simulado por fetch:
// un borrador se guarda incompleto, publicar sigue siendo estricto y el costo
// del margen objetivo sale de las compras reales por variante (caso MALIBU).

type Call = { path: string; method: string; body: unknown }
type Handler = (url: URL, init?: RequestInit) => Response | undefined

async function withSupabase(handler: Handler, run: (calls: Call[]) => Promise<void>) {
  const previousEnv = { ...process.env }
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://draft-publish.invalid"
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

// MALIBU tal como está en la base (25/10/2026): tres variantes inactivas con
// una compra recibida cada una, vinculada por variant_id.
const MALIBU_VARIANTS = [
  { id: 9, nombre: "NEGRO", activo: false },
  { id: 15, nombre: "ROSA", activo: false },
  { id: 16, nombre: "VERDE", activo: false },
]
const purchase = (variantId: number, quantity: number, unitCost: number, date: string): ProductCostLedgerRow => ({
  product_id: 9, variant_id: variantId, purchase_date: date, quantity, received_quantity: quantity,
  reception_status: "recibida", total_cost: quantity * unitCost,
})
const MALIBU_PURCHASES = [
  purchase(9, 6, 12_790, "2026-10-08"),
  purchase(15, 3, 12_790, "2026-03-16"),
  purchase(16, 3, 12_790, "2026-03-26"),
]

function costHandler(variants: typeof MALIBU_VARIANTS, purchases: ProductCostLedgerRow[], extra: Handler = () => undefined): Handler {
  return (url, init) => {
    if (url.pathname === "/rest/v1/producto_variantes") return Response.json(variants)
    if (url.pathname === "/rest/v1/product_cost_entries") return Response.json(purchases)
    if (url.pathname === "/rest/v1/product_pricing") return Response.json([])
    return extra(url, init)
  }
}

const draftCatalog = (catalog: Record<string, unknown> = {}) => ({
  catalog: {
    nombre: "AURICULAR INALAMBRICO MALIBU",
    slug: "auricular-inalambrico-malibu",
    descripcion: "",
    precio: 0,
    activo: false,
    destacado: false,
    categoria_id: null,
    pricing_mode: "manual",
    peso_empaquetado_kg: "",
    alto_paquete_cm: "",
    ancho_paquete_cm: "",
    largo_paquete_cm: "",
    ...catalog,
  },
  primarySku: "AUMN01",
  variantStates: MALIBU_VARIANTS.map((variant) => ({ id: variant.id, active: false })),
  expectedRevision: 0,
})

const savedRpc = () => Response.json({ product: { id: 9, catalog_revision: 1 }, variants: [] })

test("borrador inactivo sin logística, categoría, descripción y con precio 0 se guarda (A-D)", async () => {
  const route = await import("../../app/api/admin/products/[id]/catalog/route")
  await withSupabase((url) => {
    if (url.pathname === "/rest/v1/rpc/update_product_commercial_configuration_checked") return savedRpc()
    return undefined
  }, async (calls) => {
    const response = await route.PATCH(request("/api/admin/products/9/catalog", "PATCH", draftCatalog()), { params: Promise.resolve({ id: "9" }) })
    assert.equal(response.status, 200)
    const sent = (calls[0].body as { p_catalog: Record<string, unknown> }).p_catalog
    assert.deepEqual(
      [sent.peso_empaquetado_kg, sent.alto_paquete_cm, sent.ancho_paquete_cm, sent.largo_paquete_cm],
      [null, null, null, null],
      "la logística vacía viaja como null, sin inventar valores",
    )
    assert.equal(sent.activo, false)
    assert.equal(sent.precio, 0)
  })
})

test("en un borrador lo cargado se valida igual: una medida inválida se rechaza", async () => {
  const route = await import("../../app/api/admin/products/[id]/catalog/route")
  await withSupabase(() => undefined, async (calls) => {
    const response = await route.PATCH(
      request("/api/admin/products/9/catalog", "PATCH", draftCatalog({ peso_empaquetado_kg: "-1" })),
      { params: Promise.resolve({ id: "9" }) },
    )
    assert.equal(response.status, 400)
    assert.deepEqual(calls, [], "no se escribe nada")
  })
})

test("una llamada directa a la API no publica un producto sin peso y medidas (U)", async () => {
  const route = await import("../../app/api/admin/products/[id]/catalog/route")
  await withSupabase(() => undefined, async (calls) => {
    const response = await route.PATCH(
      request("/api/admin/products/9/catalog", "PATCH", draftCatalog({ activo: true, precio: 20000, categoria_id: 1 })),
      { params: Promise.resolve({ id: "9" }) },
    )
    assert.equal(response.status, 400)
    assert.match(((await response.json()) as { error: string }).error, /obligatorio/)
    assert.deepEqual(calls, [])
  })
})

test("costo desconocido no impide guardar un borrador en margen objetivo y no inventa costos (R/S)", async () => {
  const route = await import("../../app/api/admin/products/[id]/catalog/route")
  await withSupabase(costHandler(MALIBU_VARIANTS, [], (url) =>
    url.pathname === "/rest/v1/rpc/update_product_commercial_configuration_checked" ? savedRpc() : undefined,
  ), async (calls) => {
    const response = await route.PATCH(
      request("/api/admin/products/9/catalog", "PATCH", draftCatalog({ pricing_mode: "target_margin", target_margin_percent: 30, precio: 18000 })),
      { params: Promise.resolve({ id: "9" }) },
    )
    assert.equal(response.status, 200)
    const body = await response.json() as { pricingWarning?: string }
    assert.match(body.pricingWarning ?? "", /Costo desconocido: no hay un costo de compra disponible para calcular el precio automáticamente/)
    const rpc = calls.find((call) => call.path === "/rest/v1/rpc/update_product_commercial_configuration_checked")!
    const args = rpc.body as { p_catalog: Record<string, unknown>; p_pricing_mode: string; p_target_margin_percent: number }
    assert.equal(args.p_catalog.precio, 18000, "se conserva el precio de la ficha, no se calcula con un costo inventado")
    assert.equal(args.p_pricing_mode, "target_margin")
    assert.equal(args.p_target_margin_percent, 30)
    assert.equal(calls.some((call) => call.path === "/rest/v1/product_cost_entries" && call.method !== "GET"), false, "nunca se crea un costo")
  })
})

test("publicar en margen objetivo sin costo sigue bloqueado", async () => {
  const route = await import("../../app/api/admin/products/[id]/catalog/route")
  await withSupabase(costHandler(MALIBU_VARIANTS, []), async (calls) => {
    const response = await route.PATCH(
      request("/api/admin/products/9/catalog", "PATCH", draftCatalog({
        activo: true, pricing_mode: "target_margin", target_margin_percent: 30, categoria_id: 1,
        peso_empaquetado_kg: 0.3, alto_paquete_cm: 8, ancho_paquete_cm: 18, largo_paquete_cm: 20,
      })),
      { params: Promise.resolve({ id: "9" }) },
    )
    assert.equal(response.status, 400)
    assert.match(((await response.json()) as { error: string }).error, /Costo desconocido/)
    assert.equal(calls.some((call) => call.path.startsWith("/rest/v1/rpc/")), false)
  })
})

test("MALIBU obtiene su costo de las compras existentes aunque sus variantes estén inactivas (T/O)", async () => {
  const route = await import("../../app/api/admin/products/[id]/pricing/route")
  await withSupabase(costHandler(MALIBU_VARIANTS, MALIBU_PURCHASES), async () => {
    const response = await route.GET(request("/api/admin/products/9/pricing", "GET"), { params: Promise.resolve({ id: "9" }) })
    assert.equal(response.status, 200)
    const body = await response.json() as { knownUnitCost: number | null; missingVariantCosts: unknown[]; variantCosts: Array<{ variantId: number; unitCost: number }> }
    assert.equal(body.knownUnitCost, 12_790)
    assert.deepEqual(body.missingVariantCosts, [], "no muestra Costo desconocido")
    assert.deepEqual(body.variantCosts.map((entry) => [entry.variantId, entry.unitCost]), [[9, 12_790], [15, 12_790], [16, 12_790]])
  })

  // Causa raíz: el guardado manda las tres variantes inactivas. Antes la
  // selección de variantes "vendibles" quedaba vacía y respondía no_cost
  // ("Costo desconocido") aunque las tres tienen compra real.
  const resolutions = resolveProductVariantCosts(buildProductCostLedgers(MALIBU_PURCHASES), 9, MALIBU_VARIANTS, "2026-10-25T12:00:00.000Z")
  const draftStates = MALIBU_VARIANTS.map((variant) => ({ id: variant.id, active: false }))
  assert.deepEqual(resolveTargetMarginCostBasis(selectRelevantVariantCosts(resolutions, [], draftStates)), { ok: true, cost: 12_790 })
})

test("variantes con costos distintos: el margen usa el mayor costo de las vendibles, de forma determinista (P)", async () => {
  const purchases = [
    purchase(9, 6, 12_790, "2026-10-08"),
    purchase(15, 3, 13_500, "2026-03-16"),
    purchase(16, 3, 14_000, "2026-03-26"),
  ]
  const route = await import("../../app/api/admin/products/[id]/pricing/route")
  await withSupabase(costHandler(MALIBU_VARIANTS, purchases), async () => {
    const response = await route.GET(request("/api/admin/products/9/pricing", "GET"), { params: Promise.resolve({ id: "9" }) })
    const body = await response.json() as { knownUnitCost: number | null }
    assert.equal(body.knownUnitCost, 14_000, "borrador: pesan todas las variantes, gana la más cara")
  })

  // Con NEGRO activa (y ROSA/VERDE no), el precio se fija para lo que se vende.
  const ledgers = buildProductCostLedgers(purchases)
  const resolutions = resolveProductVariantCosts(ledgers, 9, MALIBU_VARIANTS, "2026-10-25T12:00:00.000Z")
  const onlyBlack = selectRelevantVariantCosts(resolutions, [9], null)
  assert.deepEqual(resolveTargetMarginCostBasis(onlyBlack), { ok: true, cost: 12_790 })
  const blackAndGreen = selectRelevantVariantCosts(resolutions, [9], [{ id: 16, active: true }])
  assert.deepEqual(resolveTargetMarginCostBasis(blackAndGreen), { ok: true, cost: 14_000 })
  // Mismo resultado sin importar el orden de las compras o variantes.
  const shuffled = resolveProductVariantCosts(buildProductCostLedgers([...purchases].reverse()), 9, [...MALIBU_VARIANTS].reverse(), "2026-10-25T12:00:00.000Z")
  assert.equal(getWorstCaseKnownCost(selectRelevantVariantCosts(shuffled, [], null)), 14_000)
})

test("variantes sin ningún costo: costo desconocido; una sin costo bloquea el margen (Q)", () => {
  const noCosts = resolveProductVariantCosts(buildProductCostLedgers([]), 9, MALIBU_VARIANTS, "2026-10-25T12:00:00.000Z")
  const basis = resolveTargetMarginCostBasis(selectRelevantVariantCosts(noCosts, [], null))
  assert.equal(basis.ok, false)
  assert.equal(basis.ok ? null : basis.reason, "no_cost")

  const partial = resolveProductVariantCosts(buildProductCostLedgers([purchase(9, 6, 12_790, "2026-10-08")]), 9, MALIBU_VARIANTS, "2026-10-25T12:00:00.000Z")
  const partialBasis = resolveTargetMarginCostBasis(selectRelevantVariantCosts(partial, [], null))
  assert.equal(partialBasis.ok ? null : partialBasis.reason, "missing_variant_cost")
})

test("producto sin variantes y producto con una variante: el margen usa su costo (M/N)", () => {
  const simple = resolveProductVariantCosts(
    buildProductCostLedgers([{ ...purchase(9, 4, 9_000, "2026-10-01"), variant_id: null }]),
    9, [], "2026-10-25T12:00:00.000Z",
  )
  assert.deepEqual(resolveTargetMarginCostBasis(selectRelevantVariantCosts(simple, [], null)), { ok: true, cost: 9_000 })

  const single = resolveProductVariantCosts(
    buildProductCostLedgers([purchase(9, 6, 12_790, "2026-10-08")]),
    9, [MALIBU_VARIANTS[0]], "2026-10-25T12:00:00.000Z",
  )
  assert.deepEqual(resolveTargetMarginCostBasis(selectRelevantVariantCosts(single, [], null)), { ok: true, cost: 12_790 })
  assert.deepEqual(resolveTargetMarginCostBasis(selectRelevantVariantCosts(single, [9], null)), { ok: true, cost: 12_790 })
})
