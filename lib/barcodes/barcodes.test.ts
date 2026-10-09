import assert from "node:assert/strict"
import test from "node:test"

import {
  findCatalogArticleByCode,
  mergeCatalogMatch,
  type CatalogCodeOwner,
  type CatalogCodeStore,
  type CatalogLookupProduct,
  type CatalogLookupVariant,
} from "./catalog-lookup.ts"
import { BATCH_CODE, PARCEL_CODE, barcodeOrigin, barcodeOriginLabel, isPrintableBarcode, isReservedProductBarcode } from "./codes.ts"
import { buildLabelsDocument, expandLabels } from "./labels-document.ts"
import { renderCode128Svg } from "./render.ts"
import { DISPATCH_STAGE_LABELS, dispatchStage } from "../admin/dispatch.ts"
import type { BusinessCostCatalogProduct } from "../supabase/queries/business-costs.ts"

test("jerarquía de códigos: producto BEYONIX, bulto y lote no se confunden", () => {
  assert.equal(barcodeOrigin("BX-AUR-000001"), "beyonix")
  assert.equal(barcodeOrigin("7790001000017"), "fabricante")
  assert.equal(barcodeOrigin("bx-aur-000001"), "fabricante")
  assert.equal(barcodeOrigin("  "), null)
  assert.equal(barcodeOriginLabel(null), "Código pendiente")
  assert.match("BX-PKG-1050-02", PARCEL_CODE)
  assert.match("BX-PKG-1050-R2-02", PARCEL_CODE)
  assert.doesNotMatch("BX-AUR-000001", PARCEL_CODE)
  assert.match("DSP-20261007-001", BATCH_CODE)
  assert.equal(isReservedProductBarcode("bx-pkg-1050-01"), true)
  assert.equal(isReservedProductBarcode("DSP-20261007-001"), true)
  assert.equal(isReservedProductBarcode("BX-AUR-000001"), false)
  assert.equal(isPrintableBarcode("7790001000017"), true)
  assert.equal(isPrintableBarcode("CÓDIGO"), false)
  assert.equal(isPrintableBarcode(" ABC"), false)
})

test("Code 128 se genera en el servidor y rechaza texto no imprimible", () => {
  const svg = renderCode128Svg("BX-AUR-000001")
  assert.match(svg, /^<svg\b/)
  assert.notEqual(svg, renderCode128Svg("BX-AUR-000002"))
  assert.throws(() => renderCode128Svg("ÑANDÚ"), /Code 128/)
})

test("etiquetas: N copias, A4 o térmica, texto escapado y lote con totales", () => {
  const svgs = { "BX-AUR-000001": "<svg></svg>", "BX-PKG-1050-01": "<svg></svg>", "DSP-20261007-001": "<svg></svg>" }
  assert.equal(expandLabels([{ kind: "product", code: "BX-AUR-000001", name: "A", copies: 3 }]).length, 3)
  assert.equal(expandLabels([{ kind: "product", code: "BX-AUR-000001", name: "A", copies: 0 }]).length, 1)
  const product = buildLabelsDocument([{ kind: "product", code: "BX-AUR-000001", name: "Auriculares <Pro> & más", variant: "Negro", sku: "AUR-01", copies: 2 }], svgs, "a4")
  assert.equal(product.match(/<section class="label product">/g)?.length, 2)
  assert.match(product, /Auriculares &lt;Pro&gt; &amp; más/)
  assert.match(product, /Negro · SKU AUR-01/)
  assert.match(product, /@page \{ size: A4/)
  const parcel = buildLabelsDocument([{ kind: "parcel", code: "BX-PKG-1050-01", orderCode: "BX-1050", index: 1, count: 3 }], svgs, "single")
  assert.match(parcel, /Pedido BX-1050/)
  assert.match(parcel, /Bulto 1\/3/)
  assert.match(parcel, /@page \{ size: 100mm 100mm/)
  const lot = buildLabelsDocument([{ kind: "batch", code: "DSP-20261007-001", orderCount: 4, parcelCount: 7 }], svgs, "a4")
  assert.match(lot, /LOTE DE ENVÍO/)
  assert.match(lot, /Pedidos: 4 \/ Bultos: 7/)
  assert.throws(() => buildLabelsDocument([{ kind: "product", code: "OTRO", name: "X" }], svgs, "a4"), /Falta el código/)
})

type MemoryProduct = CatalogLookupProduct & { variants?: Omit<CatalogLookupVariant, "producto_id">[] }

// Store en memoria con la misma semántica que los registros de identidad
// (clave exacta normalizada) y contador de consultas por clave.
function memoryStore(products: MemoryProduct[], costSkus: Record<number, string> = {}, aliases: Record<string, CatalogCodeOwner> = {}) {
  const barcodes = new Map<string, CatalogCodeOwner>()
  const skus = new Map<string, CatalogCodeOwner>()
  const variants = new Map<number, CatalogLookupVariant>()
  const byId = new Map<number, MemoryProduct>()
  const calls: string[] = []
  for (const product of products) {
    byId.set(product.id, product)
    if (product.codigo_barra?.trim()) barcodes.set(product.codigo_barra.trim(), { productId: product.id, variantId: null })
    if (product.sku?.trim()) skus.set(product.sku.trim().toUpperCase(), { productId: product.id, variantId: null })
    for (const variant of product.variants ?? []) {
      variants.set(variant.id, { ...variant, producto_id: product.id })
      if (variant.codigo_barra?.trim()) barcodes.set(variant.codigo_barra.trim(), { productId: null, variantId: variant.id })
      if (variant.sku?.trim()) skus.set(variant.sku.trim().toUpperCase(), { productId: null, variantId: variant.id })
    }
  }
  const store: CatalogCodeStore = {
    async barcodeOwner(code) { calls.push(`barcode:${code}`); return barcodes.get(code) ?? null },
    async aliasOwner(code) { calls.push(`alias:${code}`); return aliases[code] ?? null },
    async skuOwner(sku) { calls.push(`sku:${sku}`); return skus.get(sku) ?? null },
    async variant(id) { calls.push(`variant:${id}`); return variants.get(id) ?? null },
    async product(id) {
      calls.push(`product:${id}`)
      const product = byId.get(id)
      if (!product) return null
      const { variants: productVariants, ...fields } = product
      return { ...fields, variantCount: productVariants?.length ?? 0, soleVariantId: productVariants?.length === 1 ? productVariants[0].id : null }
    },
    async latestProductCostSku(id) { calls.push(`cost-sku:${id}`); return costSkus[id] ?? null },
  }
  return { store, calls }
}

const auriculares: MemoryProduct = {
  id: 1, nombre: "Auriculares", activo: true, stock: 5, sku: "AUR", codigo_barra: "AUR-PADRE", variants: [
    { id: 11, nombre: "Negro", activo: true, stock: 3, sku: "AUR-N", color_hex: "#000000", codigo_barra: "7790001000017" },
    { id: 12, nombre: "Blanco", activo: false, stock: 2, sku: "AUR-B", color_hex: "#FFFFFF", codigo_barra: "BX-AUR-000001" },
  ],
}
const legacy: MemoryProduct = { id: 2, nombre: "Lámpara Ñandú", activo: true, stock: 1, sku: null, codigo_barra: "LEG-BAR" }

test("Compras: el escaneo resuelve server-side la variante exacta (fabricante y BEYONIX)", async () => {
  const { store } = memoryStore([auriculares, legacy], { 2: "LEG-SKU" })
  assert.deepEqual(await findCatalogArticleByCode(store, " 7790001000017 "), {
    value: "v:1:11",
    matchedBy: "barcode",
    product: { id: 1, nombre: "Auriculares", activo: true, stock: 5, sku: "AUR", codigo_barra: "AUR-PADRE" },
    variant: { id: 11, producto_id: 1, nombre: "Negro", activo: true, stock: 3, sku: "AUR-N", color_hex: "#000000", codigo_barra: "7790001000017" },
  })
  const beyonix = await findCatalogArticleByCode(store, "BX-AUR-000001")
  assert.equal(beyonix?.value, "v:1:12")
  assert.equal(beyonix?.variant?.color_hex, "#FFFFFF")
  assert.equal((await findCatalogArticleByCode(store, "aur-b"))?.matchedBy, "sku")
  const legacyMatch = await findCatalogArticleByCode(store, "LEG-BAR")
  assert.equal(legacyMatch?.value, "p:2")
  assert.equal(legacyMatch?.variant, null)
  assert.equal(legacyMatch?.product.sku, "LEG-SKU", "mismo SKU de respaldo que el catálogo de Compras")
  assert.equal((await findCatalogArticleByCode(store, "leg-sku")), null, "el SKU de costos no es identidad del catálogo")
})

test("Compras: código inexistente, vacío o del producto padre con variantes no se reconoce", async () => {
  const { store, calls } = memoryStore([auriculares, legacy])
  assert.equal(await findCatalogArticleByCode(store, "NO-EXISTE"), null)
  assert.equal(await findCatalogArticleByCode(store, "7790001000017X"), null, "búsqueda exacta, sin prefijos")
  assert.equal(await findCatalogArticleByCode(store, "779000100001"), null)
  assert.equal(await findCatalogArticleByCode(store, "AUR-PADRE"), null, "el código del padre no indica la variante")
  assert.equal(await findCatalogArticleByCode(store, "AUR"), null)
  calls.length = 0
  assert.equal(await findCatalogArticleByCode(store, "   "), null)
  assert.equal(await findCatalogArticleByCode(store, "X".repeat(129)), null)
  assert.deepEqual(calls, [], "no consulta la base con códigos inválidos")
})

test("Compras: con más de 1000 productos encuentra la variante por clave exacta, sin recorrer el catálogo", async () => {
  const products: MemoryProduct[] = Array.from({ length: 1500 }, (_, index) => ({
    id: index + 1, nombre: `Producto ${index + 1}`, activo: true, stock: 0, sku: `P-${index + 1}`, codigo_barra: null,
    variants: [{ id: 100_000 + index, nombre: `Color ${index}`, activo: true, stock: 0, sku: `P-${index + 1}-V`, color_hex: "#123456", codigo_barra: `779${String(index).padStart(10, "0")}` }],
  }))
  const { store, calls } = memoryStore(products)
  const match = await findCatalogArticleByCode(store, "7790000001499")
  assert.equal(match?.value, "v:1500:101499")
  assert.equal(match?.product.nombre, "Producto 1500")
  assert.deepEqual(calls, ["barcode:7790000001499", "variant:101499", "product:1500"])
})

test("Compras: el artículo escaneado fuera del catálogo cargado se incorpora sin duplicar", async () => {
  const { store } = memoryStore([auriculares, legacy])
  const match = await findCatalogArticleByCode(store, "BX-AUR-000001")
  assert.ok(match)
  const loaded: BusinessCostCatalogProduct[] = [
    { id: 1, nombre: "Auriculares", activo: true, stock: 5, sku: "AUR", producto_variantes: [{ id: 12, nombre: "Blanco", activo: false, stock: 2, sku: "AUR-B", color_hex: "#FFFFFF", codigo_barra: "BX-AUR-000001" }] },
  ]
  assert.equal(mergeCatalogMatch(loaded, match), loaded, "si ya está cargado no cambia el estado")
  const missingVariant = mergeCatalogMatch([{ ...loaded[0], producto_variantes: [] }], match)
  assert.deepEqual(missingVariant[0].producto_variantes?.map((variant) => variant.id), [12])
  const empty = mergeCatalogMatch([{ id: "cost:x", nombre: "Zeta", activo: true, stock: null, standalone_key: "x" }], match)
  assert.deepEqual(empty.map((item) => item.id), [1, "cost:x"])
  assert.equal(empty[0].producto_variantes?.[0]?.codigo_barra, "BX-AUR-000001")
  assert.equal(empty[0].standalone_key, null)
})

test("estados de despacho visibles", () => {
  assert.equal(dispatchStage({ package: null }), "pending")
  assert.equal(dispatchStage({ package: { status: "preparing", parcel_count: null } }), "packing")
  assert.equal(dispatchStage({ package: { status: "prepared", parcel_count: null } }), "packed")
  assert.equal(dispatchStage({ package: { status: "prepared", parcel_count: 2 } }), "parcels_ready")
  assert.equal(dispatchStage({ package: { status: "prepared", parcel_count: 2 }, batchStatus: "open" }), "in_batch")
  assert.equal(dispatchStage({ package: { status: "prepared", parcel_count: 2 }, batchStatus: "closed" }), "batch_closed")
  assert.equal(dispatchStage({ package: { status: "prepared", parcel_count: 2 }, handedOver: true }), "handed_over")
  assert.deepEqual(Object.values(DISPATCH_STAGE_LABELS), ["Pendiente", "En armado", "Completo", "Bultos listos", "En lote", "Lote cerrado", "Entregado a Andreani"])
})

test("Compras: códigos equivalentes resuelven la variante física o piden elegirla si son del grupo", async () => {
  const encendedor: MemoryProduct = {
    id: 4, nombre: "Encendedor USB", activo: true, stock: 7, sku: "ENC", codigo_barra: null, venta_aleatoria: true, variants: [
      { id: 41, nombre: "Negro", activo: true, stock: 4, sku: "ENC-NEG", color_hex: "#000000", codigo_barra: "7170972998100" },
      { id: 42, nombre: "Rojo", activo: true, stock: 3, sku: "ENC-ROJ", color_hex: "#EF4444", codigo_barra: null },
    ],
  }
  const { store } = memoryStore([encendedor], {}, {
    "7791234567890": { productId: 4, variantId: 42 },
    "BX-ENC-000123": { productId: 4, variantId: null },
  })
  const variantAlias = await findCatalogArticleByCode(store, "7791234567890")
  assert.equal(variantAlias?.value, "v:4:42")
  assert.equal(variantAlias?.matchedBy, "alias")
  assert.equal(variantAlias?.product.venta_aleatoria, true, "informa el grupo comercial aleatorio")
  const group = await findCatalogArticleByCode(store, "BX-ENC-000123")
  assert.deepEqual([group?.requiresVariant, group?.value, group?.variant], [true, "", null])
  // El código principal sigue ganando sobre cualquier alias.
  assert.equal((await findCatalogArticleByCode(store, "7170972998100"))?.matchedBy, "barcode")
})

test("Compras: los tres códigos del encendedor aleatorio simple resuelven su artículo único", async () => {
  const encendedor: MemoryProduct = {
    id: 70, nombre: "Encendedor eléctrico con carga USB", activo: true, stock: 12,
    sku: "ENCENUSB001", codigo_barra: "7170972998100", modo_color: "aleatorio_simple",
    variants: [{ id: 701, nombre: "ALEATORIO", activo: true, stock: 12, sku: null, color_hex: "#8B5A2B", codigo_barra: null }],
  }
  const { store } = memoryStore([encendedor], {}, {
    "7950000250666": { productId: 70, variantId: null },
    "2025122709035": { productId: 70, variantId: null },
  })
  for (const code of ["7170972998100", "7950000250666", "2025122709035", "ENCENUSB001"]) {
    const match = await findCatalogArticleByCode(store, code)
    assert.equal(match?.value, "v:70:701")
    assert.equal(match?.requiresVariant, undefined)
    assert.equal(match?.variant?.stock, 12)
  }
})
