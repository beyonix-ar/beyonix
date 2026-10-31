import { foldText } from "./report-values.ts"
import { normalizeMercadoLibreSku } from "./sku-aliases.ts"
import type { CatalogSkuTarget } from "./sku-reconciliation.ts"

/**
 * Vinculación segura de una línea de Mercado Libre con el catálogo. Sólo usa
 * claves explícitas; nunca coincidencias aproximadas por título.
 *
 * Orden:
 *  1. vínculo ya guardado en la venta existente (se conserva al reimportar);
 *  2. SKU exacto actual del catálogo (único);
 *  3. alias explícito de SKU histórico;
 *  4. publicación + variante explícita;
 *  5. si nada resuelve de forma segura: sin vincular.
 */

export type MercadoLibreMatchOrigin = "preserved" | "exact_sku" | "sku_alias" | "listing_variant"

export const MERCADOLIBRE_MATCH_ORIGIN_LABEL: Record<MercadoLibreMatchOrigin, string> = {
  preserved: "Vínculo existente",
  exact_sku: "SKU exacto",
  sku_alias: "Alias de SKU",
  listing_variant: "Publicación + variante",
}

export type ProductChannelMappingType = "sku_alias" | "listing_variant"
export type ProductChannelMappingOrigin = "manual_import_preview" | "manual_admin"

export interface ProductChannelMapping {
  id: string
  mapping_type: ProductChannelMappingType
  match_key: string
  /** null si el producto se borró del catálogo (el vínculo queda inactivo). */
  product_id: number | null
  variant_id: number | null
  origin: ProductChannelMappingOrigin
  /** Vigencia inclusiva (YYYY-MM-DD); null = sin límite de ese lado. */
  valid_from: string | null
  valid_to: string | null
}

export interface MercadoLibreMatchableRow {
  sku: string | null
  /** Fecha de la venta; decide qué vínculos con vigencia aplican. */
  sale_date?: string | null
  raw_data: { parsed?: Record<string, unknown> } | Record<string, unknown>
}

export interface MercadoLibreProductMatch {
  origin: MercadoLibreMatchOrigin
  productId: number
  variantId: number | null
  /** Vínculo explícito usado (alias o publicación + variante). */
  mappingId: string | null
  /** true si el vínculo lo cargó un administrador a mano. */
  manual: boolean
}

/** "MLA-3268194664" → "MLA3268194664". */
export function normalizeListingKey(value: unknown) {
  return String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
}

/** "Color :  Negro" → "color:negro" (sin tildes ni espacios repetidos). */
export function normalizeVariantKey(value: unknown) {
  return foldText(value).replace(/\s*:\s*/g, ":").replace(/\s+/g, " ").trim()
}

/** Clave publicación + variante; null si falta alguna de las dos partes. */
export function getListingVariantKey(listingId: unknown, variant: unknown) {
  const listing = normalizeListingKey(listingId)
  const variantKey = normalizeVariantKey(variant)
  return listing && variantKey ? `${listing}|${variantKey}` : null
}

function parsedOf(row: MercadoLibreMatchableRow) {
  const raw = row.raw_data as { parsed?: Record<string, unknown> }
  return raw.parsed && typeof raw.parsed === "object" ? raw.parsed : {}
}

export function getMercadoLibreRowListingVariantKey(row: MercadoLibreMatchableRow) {
  const parsed = parsedOf(row)
  return getListingVariantKey(parsed.listing_id, parsed.variant)
}

export interface MercadoLibreMatchingContext {
  /** SKU normalizado → destino único del catálogo actual. */
  catalogTargetsBySku: Map<string, CatalogSkuTarget>
  /** Productos que tienen variantes: un vínculo sin variante ya no es seguro. */
  productsWithVariants: Set<number>
  /** Variantes existentes, para descartar vínculos que apuntan a algo borrado. */
  variantProduct: Map<number, number>
  existingProducts: Set<number>
  /** Puede haber varios por clave, en períodos de vigencia distintos. */
  aliasesBySku: Map<string, ProductChannelMapping[]>
  mappingsByListingVariant: Map<string, ProductChannelMapping[]>
}

export function buildMercadoLibreMatchingContext(input: {
  catalogTargetsBySku: Map<string, CatalogSkuTarget>
  catalog: Array<{ id: number; producto_variantes: Array<{ id: number }> | null }>
  mappings: ProductChannelMapping[]
}): MercadoLibreMatchingContext {
  const productsWithVariants = new Set<number>()
  const variantProduct = new Map<number, number>()
  const existingProducts = new Set<number>()
  for (const product of input.catalog) {
    existingProducts.add(product.id)
    for (const variant of product.producto_variantes ?? []) {
      productsWithVariants.add(product.id)
      variantProduct.set(variant.id, product.id)
    }
  }
  const aliasesBySku = new Map<string, ProductChannelMapping[]>()
  const mappingsByListingVariant = new Map<string, ProductChannelMapping[]>()
  for (const mapping of input.mappings) {
    const target = mapping.mapping_type === "sku_alias" ? aliasesBySku : mappingsByListingVariant
    target.set(mapping.match_key, [...(target.get(mapping.match_key) ?? []), mapping])
  }
  return {
    catalogTargetsBySku: input.catalogTargetsBySku,
    productsWithVariants,
    variantProduct,
    existingProducts,
    aliasesBySku,
    mappingsByListingVariant,
  }
}

/** Un vínculo explícito sólo vale si su destino sigue existiendo y es inequívoco. */
function isSafeTarget(context: MercadoLibreMatchingContext, productId: number | null, variantId: number | null) {
  if (productId == null || !context.existingProducts.has(productId)) return false
  if (variantId == null) return !context.productsWithVariants.has(productId)
  return context.variantProduct.get(variantId) === productId
}

const SALE_DAY_FORMAT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Argentina/Buenos_Aires",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
})

/** Día calendario de la venta en Argentina (YYYY-MM-DD); null si la fecha no es válida. */
export function getMercadoLibreSaleDay(saleDate: unknown) {
  if (typeof saleDate !== "string" || !saleDate.trim()) return null
  const parsed = new Date(saleDate)
  return Number.isNaN(parsed.getTime()) ? null : SALE_DAY_FORMAT.format(parsed)
}

/**
 * Vigencia inclusiva: valid_from ≤ día de venta ≤ valid_to. Sin fecha de
 * venta válida sólo aplica un vínculo sin vigencia (no se adivina el período).
 */
export function isMappingEffectiveOn(mapping: Pick<ProductChannelMapping, "valid_from" | "valid_to">, saleDay: string | null) {
  if (saleDay == null) return mapping.valid_from == null && mapping.valid_to == null
  return (mapping.valid_from == null || mapping.valid_from <= saleDay) && (mapping.valid_to == null || saleDay <= mapping.valid_to)
}

function fromMappings(
  context: MercadoLibreMatchingContext,
  mappings: ProductChannelMapping[] | undefined,
  saleDay: string | null,
): MercadoLibreProductMatch | null {
  const effective = (mappings ?? []).filter((mapping) => isMappingEffectiveOn(mapping, saleDay))
  // La base impide períodos superpuestos; si igual hubiera más de uno, es ambiguo.
  if (effective.length !== 1) return null
  const [mapping] = effective
  if (mapping.product_id == null || !isSafeTarget(context, mapping.product_id, mapping.variant_id)) return null
  return {
    origin: mapping.mapping_type,
    productId: mapping.product_id,
    variantId: mapping.variant_id,
    mappingId: mapping.id,
    manual: true,
  }
}

export interface UnlinkedMercadoLibreGroup {
  key: string
  /** Vínculo que se puede crear para este grupo; null si no hay clave segura. */
  mappingType: ProductChannelMappingType | null
  sku: string | null
  listingId: string | null
  variant: string | null
  title: string
  lines: number
}

/**
 * Agrupa las líneas sin vincular por la clave explícita que las resolvería:
 * el SKU original si existe; si no, publicación + variante. Una línea sin
 * SKU ni variante no tiene clave segura y sólo puede importarse sin vincular.
 */
export function groupUnlinkedMercadoLibreRows(
  rows: Array<MercadoLibreMatchableRow & { product_name: string }>,
  matches: Array<MercadoLibreProductMatch | null>,
): UnlinkedMercadoLibreGroup[] {
  const groups = new Map<string, UnlinkedMercadoLibreGroup>()
  rows.forEach((row, index) => {
    if (matches[index]) return
    const parsed = parsedOf(row)
    const sku = normalizeMercadoLibreSku(row.sku)
    const listingVariantKey = getMercadoLibreRowListingVariantKey(row)
    const key = sku ? `sku:${sku}` : listingVariantKey ? `listing:${listingVariantKey}` : `none:${row.product_name}`
    const current = groups.get(key)
    if (current) {
      current.lines += 1
      return
    }
    groups.set(key, {
      key,
      mappingType: sku ? "sku_alias" : listingVariantKey ? "listing_variant" : null,
      sku: row.sku?.trim() || null,
      listingId: typeof parsed.listing_id === "string" ? parsed.listing_id : null,
      variant: typeof parsed.variant === "string" ? parsed.variant : null,
      title: row.product_name,
      lines: 1,
    })
  })
  return [...groups.values()]
}

export function resolveMercadoLibreProductMatch(
  row: MercadoLibreMatchableRow,
  context: MercadoLibreMatchingContext,
  preserved?: { product_id: number; variant_id: number | null } | null,
): MercadoLibreProductMatch | null {
  if (preserved) {
    return { origin: "preserved", productId: preserved.product_id, variantId: preserved.variant_id, mappingId: null, manual: false }
  }

  const saleDay = getMercadoLibreSaleDay(row.sale_date)
  const sku = normalizeMercadoLibreSku(row.sku)
  if (sku) {
    const exact = context.catalogTargetsBySku.get(sku)
    if (exact) {
      return { origin: "exact_sku", productId: exact.productId, variantId: exact.variantId, mappingId: null, manual: false }
    }
    const alias = fromMappings(context, context.aliasesBySku.get(sku), saleDay)
    if (alias) return alias
  }

  const listingVariantKey = getMercadoLibreRowListingVariantKey(row)
  if (listingVariantKey) {
    const listing = fromMappings(context, context.mappingsByListingVariant.get(listingVariantKey), saleDay)
    if (listing) return listing
  }

  return null
}
