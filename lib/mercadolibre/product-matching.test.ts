import assert from "node:assert/strict"
import test from "node:test"

import { buildProductChannelMappingInsert } from "./product-mapping-request.ts"
import {
  buildMercadoLibreMatchingContext,
  getListingVariantKey,
  groupUnlinkedMercadoLibreRows,
  resolveMercadoLibreProductMatch,
  type ProductChannelMapping,
} from "./product-matching.ts"
import { buildUniqueCatalogTargetsBySku, type CatalogSkuRow } from "./sku-reconciliation.ts"

const catalog: CatalogSkuRow[] = [
  { id: 10, sku: "AP01", producto_variantes: [] },
  {
    id: 20,
    sku: null,
    producto_variantes: [
      { id: 201, sku: "MTN01" },
      { id: 202, sku: "MATE-ROSA" },
      { id: 203, sku: "MATE-VERDE" },
    ],
  },
  { id: 30, sku: null, producto_variantes: [{ id: 301, sku: "NEW-SKU" }] },
]

function mapping(overrides: Partial<ProductChannelMapping>): ProductChannelMapping {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    mapping_type: "sku_alias",
    match_key: "OLD-SKU",
    product_id: 30,
    variant_id: 301,
    origin: "manual_import_preview",
    valid_from: null,
    valid_to: null,
    ...overrides,
  }
}

function context(mappings: ProductChannelMapping[] = []) {
  return buildMercadoLibreMatchingContext({
    catalogTargetsBySku: buildUniqueCatalogTargetsBySku(catalog),
    catalog: catalog.map((product) => ({ id: product.id, producto_variantes: product.producto_variantes })),
    mappings,
  })
}

function row(sku: string | null, listing_id: string | null = "MLA3106141198", variant: string | null = "Color : Negro") {
  return { sku, product_name: "Mate Térmico Acero Inoxidable Doble Pared 236 Con Bombilla", raw_data: { parsed: { listing_id, variant } } }
}

test("orden: vínculo previo → SKU exacto → alias → publicación + variante → sin vincular", () => {
  const ctx = context([
    mapping({ match_key: "OLD-SKU" }),
    mapping({ id: "00000000-0000-4000-8000-000000000002", mapping_type: "listing_variant", match_key: "MLA3106141198|color:rosa", product_id: 20, variant_id: 202 }),
  ])

  assert.deepEqual(resolveMercadoLibreProductMatch(row("AP01"), ctx, { product_id: 20, variant_id: 203 }), {
    origin: "preserved", productId: 20, variantId: 203, mappingId: null, manual: false,
  }, "una venta ya contabilizada conserva su imputación")
  assert.equal(resolveMercadoLibreProductMatch(row("ap01 "), ctx)?.origin, "exact_sku")
  assert.equal(resolveMercadoLibreProductMatch(row("MTN01"), ctx)?.variantId, 201)
  assert.deepEqual(resolveMercadoLibreProductMatch(row("OLD-SKU"), ctx), {
    origin: "sku_alias", productId: 30, variantId: 301, mappingId: "00000000-0000-4000-8000-000000000001", manual: true,
  })
  assert.equal(resolveMercadoLibreProductMatch(row("MATEINOXROSA001", "MLA3106141198", "Color : Rosa"), ctx)?.origin, "listing_variant")
  assert.equal(resolveMercadoLibreProductMatch(row("MATEINOXVERDE001", "MLA3106141198", "Color : Verde"), ctx), null)
})

test("SKU exacto actual gana sobre un alias con la misma clave", () => {
  const ctx = context([mapping({ match_key: "AP01", product_id: 30, variant_id: 301 })])
  assert.deepEqual(resolveMercadoLibreProductMatch(row("AP01"), ctx), {
    origin: "exact_sku", productId: 10, variantId: null, mappingId: null, manual: false,
  })
})

test("SKU histórico: OLD-SKU → variante actual con NEW-SKU; sin alias no hay vínculo", () => {
  assert.equal(resolveMercadoLibreProductMatch(row("OLD-SKU", null, null), context()), null)
  const match = resolveMercadoLibreProductMatch(row("OLD-SKU", null, null), context([mapping({})]))
  assert.equal(match?.productId, 30)
  assert.equal(match?.variantId, 301)
  assert.equal(match?.origin, "sku_alias")
})

test("publicación con Negro/Rosa/Verde: sólo publicación + variante resuelve; la publicación sola no", () => {
  const ctx = context([
    ["color:negro", 201],
    ["color:rosa", 202],
    ["color:verde", 203],
  ].map(([variant, variantId], index) => mapping({
    id: `00000000-0000-4000-8000-00000000001${index}`,
    mapping_type: "listing_variant",
    match_key: `MLA3106141198|${variant}`,
    product_id: 20,
    variant_id: Number(variantId),
  })))

  assert.equal(resolveMercadoLibreProductMatch(row(null, "MLA-3106141198", "Color :  Rosa"), ctx)?.variantId, 202)
  assert.equal(resolveMercadoLibreProductMatch(row(null, "MLA3106141198", "color: verde"), ctx)?.variantId, 203)
  assert.equal(resolveMercadoLibreProductMatch(row(null, "MLA3106141198", "Color : Negro"), ctx)?.variantId, 201)
  assert.equal(resolveMercadoLibreProductMatch(row(null, "MLA3106141198", null), ctx), null, "sin variante no hay clave segura")
  assert.equal(getListingVariantKey("MLA3106141198", ""), null)
  assert.equal(resolveMercadoLibreProductMatch(row(null, "MLA999", "Color : Rosa"), ctx), null)
})

test("nunca vincula por título ni a destinos ambiguos u obsoletos", () => {
  const ctx = context([
    // Producto que hoy tiene variantes: un vínculo sin variante dejó de ser seguro.
    mapping({ match_key: "LEGACY", product_id: 20, variant_id: null }),
    // Variante que ya no pertenece a ese producto.
    mapping({ id: "00000000-0000-4000-8000-000000000003", match_key: "MOVED", product_id: 10, variant_id: 201 }),
  ])
  // El título contiene un SKU y un nombre del catálogo: igual no se usa.
  assert.equal(resolveMercadoLibreProductMatch({ sku: null, raw_data: { parsed: { listing_title: "AP01 Apoyabrazos Ergonómico" } } }, ctx), null)
  assert.equal(resolveMercadoLibreProductMatch(row("LEGACY", null, null), ctx), null)
  assert.equal(resolveMercadoLibreProductMatch(row("MOVED", null, null), ctx), null)
})

// A. Vigencia inclusiva por día calendario de la venta en Argentina.
test("vigencia: dentro usa el alias; antes o después no; sin valid_to rige desde valid_from", () => {
  const ctx = context([mapping({ valid_from: "2026-05-01", valid_to: "2026-05-31" })])
  const sale = (sale_date: string | null) => ({ ...row("OLD-SKU", null, null), sale_date })

  assert.equal(resolveMercadoLibreProductMatch(sale("2026-05-13T08:54:00-03:00"), ctx)?.variantId, 301)
  assert.equal(resolveMercadoLibreProductMatch(sale("2026-05-01T00:00:00-03:00"), ctx)?.variantId, 301, "valid_from inclusivo")
  assert.equal(resolveMercadoLibreProductMatch(sale("2026-05-31T23:59:00-03:00"), ctx)?.variantId, 301, "valid_to inclusivo (hora argentina)")
  assert.equal(resolveMercadoLibreProductMatch(sale("2026-04-30T23:59:00-03:00"), ctx), null, "venta anterior")
  assert.equal(resolveMercadoLibreProductMatch(sale("2026-06-01T00:30:00-03:00"), ctx), null, "venta posterior")
  // 01/06 02:30 UTC sigue siendo 31/05 en Argentina.
  assert.equal(resolveMercadoLibreProductMatch(sale("2026-06-01T02:30:00Z"), ctx)?.variantId, 301)

  const openEnded = context([mapping({ valid_from: "2026-05-01", valid_to: null })])
  assert.equal(resolveMercadoLibreProductMatch(sale("2030-01-01T10:00:00-03:00"), openEnded)?.variantId, 301)
  assert.equal(resolveMercadoLibreProductMatch(sale("2026-04-30T10:00:00-03:00"), openEnded), null)

  // Sin fecha válida sólo aplica un vínculo sin vigencia.
  assert.equal(resolveMercadoLibreProductMatch(sale(null), ctx), null)
  assert.equal(resolveMercadoLibreProductMatch(sale("mañana"), ctx), null)
  assert.equal(resolveMercadoLibreProductMatch(sale(null), context([mapping({})]))?.variantId, 301)
})

// B. Mismo SKU reutilizado: cada período resuelve a su destino.
test("dos alias del mismo SKU en períodos distintos resuelven sin ambigüedad", () => {
  const ctx = context([
    mapping({ id: "00000000-0000-4000-8000-0000000000a1", valid_from: null, valid_to: "2026-03-31", product_id: 20, variant_id: 202 }),
    mapping({ id: "00000000-0000-4000-8000-0000000000a2", valid_from: "2026-04-01", valid_to: null, product_id: 30, variant_id: 301 }),
  ])
  const sale = (sale_date: string) => ({ ...row("OLD-SKU", null, null), sale_date })
  assert.deepEqual(
    [sale("2026-03-31T22:00:00-03:00"), sale("2026-04-01T09:00:00-03:00")].map((item) => resolveMercadoLibreProductMatch(item, ctx)?.mappingId),
    ["00000000-0000-4000-8000-0000000000a1", "00000000-0000-4000-8000-0000000000a2"],
  )
  // Datos superpuestos (la base lo impide): ambiguo ⇒ sin vincular, nunca "el primero".
  const overlapping = context([mapping({ id: "x1" }), mapping({ id: "x2", product_id: 20, variant_id: 202 })])
  assert.equal(resolveMercadoLibreProductMatch(sale("2026-04-01T09:00:00-03:00"), overlapping), null)
})

// E. Destino borrado del catálogo.
test("un vínculo cuyo producto/variante ya no existe no se usa", () => {
  const deleted = context([mapping({ product_id: null, variant_id: null })])
  assert.equal(resolveMercadoLibreProductMatch(row("OLD-SKU", null, null), deleted), null)
  const missing = context([mapping({ product_id: 999, variant_id: null })])
  assert.equal(resolveMercadoLibreProductMatch(row("OLD-SKU", null, null), missing), null)
})

test("líneas sin vincular se agrupan por SKU original o publicación + variante", () => {
  const rows = [
    row("AURIVINEXTMALIBUVER", "MLA3976733502", "Color : Verde"),
    row("AURIVINEXTMALIBUVER", "MLA3976733502", "Color : Verde"),
    row("AP01"),
    row(null, "MLA1", "Color : Rosa"),
    row(null, null, null),
  ]
  const groups = groupUnlinkedMercadoLibreRows(rows, [null, null, { origin: "exact_sku", productId: 10, variantId: null, mappingId: null, manual: false }, null, null])
  assert.deepEqual(groups.map((group) => [group.mappingType, group.sku, group.lines]), [
    ["sku_alias", "AURIVINEXTMALIBUVER", 2],
    ["listing_variant", null, 1],
    [null, null, 1],
  ])
})

test("vínculo manual: AP01 sigue siendo SKU actual → no se crea alias redundante", () => {
  const mappingCatalog = catalog
  assert.deepEqual(buildProductChannelMappingInsert({ type: "sku_alias", sku: "AP01", productId: 10 }, mappingCatalog), {
    ok: false,
    status: 409,
    error: "El SKU AP01 existe hoy en el catálogo: se vincula por SKU exacto. Registralo como alias recién cuando cambie.",
  })
})

test("vínculo manual: variante obligatoria, publicación sin variante rechazada, alias válido", () => {
  assert.equal(buildProductChannelMappingInsert({ type: "sku_alias", sku: "MATEINOXROSA001", productId: 20 }, catalog).ok, false)
  assert.equal(buildProductChannelMappingInsert({ type: "sku_alias", sku: "MATEINOXROSA001", productId: 20, variantId: 301 }, catalog).ok, false)
  assert.equal(buildProductChannelMappingInsert({ type: "listing_variant", listingId: "MLA3106141198", variant: "", productId: 20, variantId: 202 }, catalog).ok, false)
  assert.deepEqual(buildProductChannelMappingInsert({ type: "sku_alias", sku: " mateinoxrosa001 ", productId: 20, variantId: 202 }, catalog), {
    ok: true,
    insert: {
      channel: "mercadolibre", product_id: 20, variant_id: 202, origin: "manual_import_preview",
      mapping_type: "sku_alias", match_key: "MATEINOXROSA001", external_sku: "mateinoxrosa001", listing_id: null, variant_label: null,
    },
  })
  assert.deepEqual(buildProductChannelMappingInsert({ type: "listing_variant", listingId: "mla-3106141198", variant: "Color : Rosa", productId: 20, variantId: 202 }, catalog), {
    ok: true,
    insert: {
      channel: "mercadolibre", product_id: 20, variant_id: 202, origin: "manual_import_preview",
      mapping_type: "listing_variant", match_key: "MLA3106141198|color:rosa", external_sku: null, listing_id: "MLA3106141198", variant_label: "Color : Rosa",
    },
  })
})
