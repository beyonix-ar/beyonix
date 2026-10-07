import assert from "node:assert/strict"
import test from "node:test"
import type { SupabaseClient } from "@supabase/supabase-js"

import { findCatalogArticleByCode } from "../barcodes/catalog-lookup.ts"
import { createSupabaseCatalogCodeStore } from "../barcodes/catalog-lookup-store.ts"
import type { BusinessCostCatalogProduct } from "../supabase/queries/business-costs.ts"
import {
  CATALOG_SEARCH_PAGE_SIZE,
  buildPendingPurchaseTargets,
  catalogSearchPattern,
  mergeCatalogProduct,
  normalizeCatalogSearch,
  pageCatalogSearchHits,
} from "./cost-catalog-search.ts"
import {
  collectAllRows,
  loadCatalogProductsByIds,
  loadPendingPurchaseTargets,
  searchCostCatalog,
  withPurchaseBarcode,
} from "./cost-catalog-server.ts"
import { MAX_ROWS, createFakeCostCatalogDb, type FakeDbData, type FakeProduct } from "./fixtures/cost-catalog-fake-db.ts"

// El fake reproduce la forma de supabase-js; el cast queda acotado al test.
const asSupabase = (db: ReturnType<typeof createFakeCostCatalogDb>) => db as unknown as SupabaseClient

// 1500 productos con una variante cada uno (más que el máximo de filas por
// respuesta de Supabase), más casos puntuales de fabricante, BEYONIX y legacy.
function bigCatalog(): FakeDbData {
  const productos: FakeProduct[] = Array.from({ length: 1500 }, (_, index) => ({
    id: index + 1,
    nombre: `Producto ${String(index + 1).padStart(4, "0")}`,
    sku: `P-${index + 1}`,
  }))
  const producto_variantes = productos.map((product) => ({
    id: 100_000 + product.id,
    producto_id: product.id,
    nombre: `Color ${product.id}`,
    sku: `P-${product.id}-V`,
    color_hex: "#123456",
    codigo_barra: `779${String(product.id).padStart(10, "0")}`,
  }))
  producto_variantes[1399].codigo_barra = "BX-PRO-001400"
  productos.push({ id: 2000, nombre: "Lámpara Ñandú", sku: null }, { id: 2001, nombre: "Cable legacy", sku: "LEG", codigo_barra: "LEG-BAR" })
  return {
    productos,
    producto_variantes,
    product_cost_entries: [],
  }
}

test("búsqueda: patrón literal, sin mayúsculas ni tildes", () => {
  assert.equal(normalizeCatalogSearch("  Lámpara   ÑANDÚ "), "lampara nandu")
  assert.equal(catalogSearchPattern("Lámpara"), "l[aáàäâã]mp[aáàäâã]r[aáàäâã]")
  assert.equal(catalogSearchPattern("a.b*(c)"), "[aáàäâã]\\.b\\*\\([cç]\\)")
  assert.equal(catalogSearchPattern("   "), "")
  const regex = new RegExp(catalogSearchPattern("bx-pro-0014"), "iu")
  assert.ok(regex.test("BX-PRO-001400"))
  assert.ok(new RegExp(catalogSearchPattern("lampara nandu"), "iu").test("Lámpara Ñandú"))
})

test("búsqueda: une coincidencias, ordena por nombre y pagina sin repetir", () => {
  const hits = Array.from({ length: 1500 }, (_, index) => ({ id: index + 1, nombre: `Producto ${String(1500 - index).padStart(4, "0")}` }))
  const first = pageCatalogSearchHits([...hits, hits[0]], 0)
  assert.equal(first.ids.length, CATALOG_SEARCH_PAGE_SIZE)
  assert.equal(first.ids[0], 1500)
  assert.equal(first.hasMore, true)
  const last = pageCatalogSearchHits(hits, 1470)
  assert.equal(last.ids.length, 30)
  assert.equal(last.ids.at(-1), 1)
  assert.equal(last.hasMore, false)
})

test("recorrido paginado: junta todas las filas aunque Supabase corte en 1000", async () => {
  const db = createFakeCostCatalogDb(bigCatalog())
  const rows = await collectAllRows((from, to) => asSupabase(db).from("productos").select("id").order("id").range(from, to))
  assert.equal(rows.length, 1502)
  assert.ok(MAX_ROWS < rows.length)
})

test("selector: sin texto lista por nombre en páginas, sin traer el catálogo", async () => {
  const db = createFakeCostCatalogDb(bigCatalog())
  const first = await searchCostCatalog(asSupabase(db), "", 0)
  assert.equal(first.items.length, CATALOG_SEARCH_PAGE_SIZE)
  assert.equal(first.hasMore, true)
  assert.equal(first.items[0].nombre, "Cable legacy")
  assert.equal(first.items[0].sku, "LEG")
  const tail = await searchCostCatalog(asSupabase(db), "", 1500)
  assert.deepEqual(tail.items.map((item) => item.nombre), ["Producto 1499", "Producto 1500"])
  assert.equal(tail.hasMore, false)
})

test("selector: encuentra por nombre, SKU, código de fabricante y BEYONIX más allá de 1000", async () => {
  const db = createFakeCostCatalogDb(bigCatalog())
  const admin = asSupabase(db)
  const byName = await searchCostCatalog(admin, "producto 1499", 0)
  assert.deepEqual(byName.items.map((item) => item.id), [1499])
  assert.deepEqual(byName.items[0].producto_variantes?.map((variant) => variant.id), [101499])
  assert.deepEqual((await searchCostCatalog(admin, "p-1450-v", 0)).items.map((item) => item.id), [1450])
  assert.deepEqual((await searchCostCatalog(admin, "7790000001499", 0)).items.map((item) => item.id), [1499])
  assert.deepEqual((await searchCostCatalog(admin, "bx-pro-0014", 0)).items.map((item) => item.id), [1400])
  assert.deepEqual((await searchCostCatalog(admin, "lampara nandu", 0)).items.map((item) => item.nombre), ["Lámpara Ñandú"])
  assert.deepEqual((await searchCostCatalog(admin, "no existe", 0)).items, [])

  // "producto" coincide con 1500 artículos: se pagina igual que sin texto.
  const many = await searchCostCatalog(admin, "producto", 0)
  assert.equal(many.items.length, CATALOG_SEARCH_PAGE_SIZE)
  assert.equal(many.hasMore, true)
  const end = await searchCostCatalog(admin, "producto", 1470)
  assert.equal(end.items.at(-1)?.nombre, "Producto 1500")
  assert.equal(end.hasMore, false)
})

test("escaneo exacto: con 1500 productos resuelve fabricante, BEYONIX, SKU e inexistente", async () => {
  const store = createSupabaseCatalogCodeStore(asSupabase(createFakeCostCatalogDb(bigCatalog())))
  const manufacturer = await findCatalogArticleByCode(store, "7790000001499")
  assert.equal(manufacturer?.value, "v:1499:101499")
  assert.equal(manufacturer?.variant?.color_hex, "#123456")
  assert.equal((await findCatalogArticleByCode(store, "BX-PRO-001400"))?.value, "v:1400:101400")
  assert.equal((await findCatalogArticleByCode(store, "bx-pro-001400")), null, "el código de barra es exacto")
  assert.equal((await findCatalogArticleByCode(store, "p-1450-v"))?.matchedBy, "sku")
  assert.equal((await findCatalogArticleByCode(store, "LEG-BAR"))?.value, "p:2001")
  assert.equal(await findCatalogArticleByCode(store, "7790000009999"), null)
})

test("pendientes de compra: anti-join sobre todas las compras, con regla legacy", async () => {
  const data = bigCatalog()
  data.producto_variantes.push({ id: 900_001, producto_id: 10, nombre: "Segundo color", sku: "P-10-B", codigo_barra: null })
  data.product_cost_entries = [
    { id: "c1", product_id: 1, variant_id: 100_001 },
    // Compra anterior a las variantes: cubre la primera variante del producto 10.
    { id: "c2", product_id: 10, variant_id: null },
    { id: "c3", product_id: 2001, variant_id: null },
  ]
  const targets = await loadPendingPurchaseTargets(asSupabase(createFakeCostCatalogDb(data)))
  const values = new Set(targets.map((target) => target.value))
  assert.equal(values.has("v:1:100001"), false)
  assert.equal(values.has("v:10:100010"), false)
  assert.equal(values.has("v:10:900001"), true)
  assert.equal(values.has("p:2001"), false)
  assert.equal(values.has("p:2000"), true)
  assert.equal(targets.length, 1500 - 2 + 1 + 1)
  assert.deepEqual(targets.find((target) => target.value === "v:1500:101500"), {
    value: "v:1500:101500",
    label: "Producto 1500 · Color 1500",
    sku: "P-1500-V",
  })
  assert.deepEqual(
    buildPendingPurchaseTargets({
      unpurchasedVariants: [],
      unpurchasedProducts: [{ id: 3, nombre: "Zeta", sku: null }, { id: 4, nombre: "Ábaco", sku: "AB" }],
      legacyProductIds: new Set(),
      firstVariantByProduct: new Map(),
    }).map((target) => target.label),
    ["Ábaco", "Zeta"],
  )
})

test("historial: cada compra lleva el código persistido de su variante o producto", async () => {
  assert.deepEqual(
    withPurchaseBarcode({ id: "a", variant_id: 11, productos: { codigo_barra: "PADRE" }, producto_variantes: { codigo_barra: " 7790001000017 " } }),
    { id: "a", variant_id: 11, barcode: "7790001000017" },
  )
  assert.deepEqual(
    withPurchaseBarcode({ id: "b", variant_id: null, productos: [{ codigo_barra: "LEG-BAR" }], producto_variantes: null }),
    { id: "b", variant_id: null, barcode: "LEG-BAR" },
  )
  assert.equal(withPurchaseBarcode({ id: "c", variant_id: null, productos: null, producto_variantes: null }).barcode, null)
  const products = await loadCatalogProductsByIds(asSupabase(createFakeCostCatalogDb(bigCatalog())), [1499, 5, 1499, 99_999])
  assert.deepEqual(products.map((product) => product.id), [1499, 5])
})

test("catálogo local: incorpora el artículo elegido sin duplicar", () => {
  const catalog: BusinessCostCatalogProduct[] = [
    { id: 1, nombre: "Beta", activo: true, stock: 1, producto_variantes: [{ id: 11, nombre: "Negro", activo: true, stock: 1 }] },
    { id: "cost:x", nombre: "Zeta", activo: true, stock: null, standalone_key: "x" },
  ]
  assert.equal(mergeCatalogProduct(catalog, { ...catalog[0] }), catalog)
  const withVariant = mergeCatalogProduct(catalog, { ...catalog[0], producto_variantes: [{ id: 12, nombre: "Blanco", activo: true, stock: 0 }] })
  assert.deepEqual(withVariant[0].producto_variantes?.map((variant) => variant.id), [11, 12])
  const added = mergeCatalogProduct(catalog, { id: 2, nombre: "Alfa", activo: true, stock: 0, standalone_key: null })
  assert.deepEqual(added.map((item) => item.id), [2, 1, "cost:x"])
})
