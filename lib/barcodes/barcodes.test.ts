import assert from "node:assert/strict"
import test from "node:test"

import { findCatalogArticleByCode } from "./catalog-lookup.ts"
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

test("Compras: el escaneo encuentra la variante exacta por código y luego por SKU", () => {
  const catalog: BusinessCostCatalogProduct[] = [
    { id: 1, nombre: "Auriculares", activo: true, stock: 5, sku: "AUR", codigo_barra: null, producto_variantes: [
      { id: 11, nombre: "Negro", sku: "AUR-N", activo: true, stock: 3, codigo_barra: "7790001000017" },
      { id: 12, nombre: "Blanco", sku: "AUR-B", activo: true, stock: 2, codigo_barra: "BX-AUR-000001" },
    ] },
    { id: 2, nombre: "Legacy", activo: true, stock: 1, sku: "LEG", codigo_barra: "LEG-BAR", producto_variantes: [] },
    { id: "c:x", nombre: "Insumo", activo: true, stock: 0, standalone_key: "x", sku: "AUR-N" },
  ]
  assert.deepEqual(findCatalogArticleByCode(catalog, " 7790001000017 "), { value: "v:1:11", productName: "Auriculares", variantName: "Negro", matchedBy: "barcode" })
  assert.equal(findCatalogArticleByCode(catalog, "BX-AUR-000001")?.value, "v:1:12")
  assert.equal(findCatalogArticleByCode(catalog, "aur-b")?.matchedBy, "sku")
  assert.equal(findCatalogArticleByCode(catalog, "LEG-BAR")?.value, "p:2")
  assert.equal(findCatalogArticleByCode(catalog, "NO-EXISTE"), null)
  assert.equal(findCatalogArticleByCode(catalog, ""), null)
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
