import { normalizeMercadoLibreSku } from "./sku-aliases.ts"
import {
  getListingVariantKey,
  normalizeListingKey,
  type ProductChannelMapping,
  type ProductChannelMappingType,
} from "./product-matching.ts"

export interface MappingCatalogProduct {
  id: number
  sku: string | null
  producto_variantes: Array<{ id: number; sku: string | null }> | null
}

export interface ProductChannelMappingInsert {
  channel: "mercadolibre"
  mapping_type: ProductChannelMappingType
  match_key: string
  external_sku: string | null
  listing_id: string | null
  variant_label: string | null
  product_id: number
  variant_id: number | null
  origin: "manual_import_preview"
}

export type MappingRequestResult =
  | { ok: true; insert: ProductChannelMappingInsert }
  | { ok: false; status: number; error: string }

function text(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : ""
}

function positiveInteger(value: unknown) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

/**
 * Valida un vínculo manual pedido desde la previsualización. Reglas:
 *  - alias de SKU: el SKU no puede existir hoy en el catálogo (ese caso ya se
 *    resuelve por SKU exacto; un alias sería redundante o ambiguo);
 *  - publicación + variante: ambas partes son obligatorias (la publicación
 *    sola puede tener varias variantes);
 *  - si el producto tiene variantes, la variante exacta es obligatoria.
 */
export function buildProductChannelMappingInsert(
  body: Record<string, unknown> | null,
  catalog: MappingCatalogProduct[],
): MappingRequestResult {
  const type = body?.type
  if (type !== "sku_alias" && type !== "listing_variant") {
    return { ok: false, status: 400, error: "El tipo de vínculo no es válido." }
  }

  const productId = positiveInteger(body?.productId)
  const variantId = body?.variantId == null || body.variantId === "" ? null : positiveInteger(body.variantId)
  if (!productId || (body?.variantId != null && body.variantId !== "" && !variantId)) {
    return { ok: false, status: 400, error: "Elegí el producto y la variante de BEYONIX." }
  }

  const product = catalog.find((item) => item.id === productId)
  if (!product) return { ok: false, status: 400, error: "El producto seleccionado ya no está disponible." }
  const variants = product.producto_variantes ?? []
  if (variants.length && !variantId) {
    return { ok: false, status: 400, error: "Ese producto tiene variantes: elegí la variante exacta." }
  }
  if (variantId && !variants.some((variant) => variant.id === variantId)) {
    return { ok: false, status: 400, error: "La variante seleccionada no pertenece al producto." }
  }

  const base = { channel: "mercadolibre" as const, product_id: productId, variant_id: variantId, origin: "manual_import_preview" as const }

  if (type === "sku_alias") {
    const sku = text(body?.sku, 200)
    const matchKey = normalizeMercadoLibreSku(sku)
    if (!matchKey) return { ok: false, status: 400, error: "Falta el SKU de Mercado Libre." }
    const currentSkus = new Set(
      catalog.flatMap((item) => [item.sku, ...(item.producto_variantes ?? []).map((variant) => variant.sku)])
        .map(normalizeMercadoLibreSku)
        .filter(Boolean),
    )
    if (currentSkus.has(matchKey)) {
      return {
        ok: false,
        status: 409,
        error: `El SKU ${sku} existe hoy en el catálogo: se vincula por SKU exacto. Registralo como alias recién cuando cambie.`,
      }
    }
    return {
      ok: true,
      insert: { ...base, mapping_type: "sku_alias", match_key: matchKey, external_sku: sku, listing_id: null, variant_label: null },
    }
  }

  const listingId = normalizeListingKey(text(body?.listingId, 60))
  const variantLabel = text(body?.variant, 200)
  const matchKey = getListingVariantKey(listingId, variantLabel)
  if (!matchKey) {
    return {
      ok: false,
      status: 400,
      error: "Para vincular por publicación hacen falta la publicación y la variante: la publicación sola puede ser ambigua.",
    }
  }
  return {
    ok: true,
    insert: { ...base, mapping_type: "listing_variant", match_key: matchKey, external_sku: null, listing_id: listingId, variant_label: variantLabel },
  }
}

export function isSameMappingTarget(
  existing: Pick<ProductChannelMapping, "product_id" | "variant_id">,
  insert: Pick<ProductChannelMappingInsert, "product_id" | "variant_id">,
) {
  return Number(existing.product_id) === insert.product_id && (existing.variant_id ?? null) === insert.variant_id
}
