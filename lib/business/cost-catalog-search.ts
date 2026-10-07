import type {
  BusinessCostCatalogProduct,
  CatalogPurchaseTarget,
} from "../supabase/queries/business-costs.ts"

export const CATALOG_SEARCH_PAGE_SIZE = 30
export const MAX_CATALOG_SEARCH_LENGTH = 80

const ACCENT_CLASSES: Record<string, string> = {
  a: "[aáàäâã]",
  e: "[eéèëê]",
  i: "[iíìïî]",
  o: "[oóòöôõ]",
  u: "[uúùüû]",
  n: "[nñ]",
  c: "[cç]",
}
const REGEX_META = /[\\.^$|?*+()[\]{}]/

export function normalizeCatalogSearch(value: string) {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("es")
}

// Expresión POSIX para `imatch` (~* en Postgres): coincidencia parcial, sin
// distinguir mayúsculas ni tildes, con el texto del usuario siempre literal.
export function catalogSearchPattern(query: string) {
  return [...normalizeCatalogSearch(query)]
    .map((char) => ACCENT_CLASSES[char] ?? (REGEX_META.test(char) ? `\\${char}` : char))
    .join("")
}

export type CatalogSearchHit = { id: number; nombre: string }

// Une las coincidencias de producto y de variante, ordena por nombre y corta la
// página pedida. El orden es estable entre páginas (nombre y luego id).
export function pageCatalogSearchHits(
  hits: readonly CatalogSearchHit[],
  offset: number,
  limit = CATALOG_SEARCH_PAGE_SIZE,
) {
  const unique = new Map<number, CatalogSearchHit>()
  hits.forEach((hit) => unique.set(hit.id, hit))
  const sorted = [...unique.values()].sort(
    (left, right) =>
      left.nombre.localeCompare(right.nombre, "es", { sensitivity: "base", numeric: true }) ||
      left.id - right.id,
  )
  return {
    ids: sorted.slice(offset, offset + limit).map((hit) => hit.id),
    hasMore: sorted.length > offset + limit,
  }
}

export type UnpurchasedVariant = {
  id: number
  producto_id: number
  nombre: string
  sku: string | null
  productName: string
}

export type UnpurchasedProduct = { id: number; nombre: string; sku: string | null }

// Artículos del catálogo sin ninguna compra registrada. Una compra anterior a
// la creación de variantes pertenece a la primera variante agregada; no debe
// solicitarse nuevamente.
export function buildPendingPurchaseTargets({
  unpurchasedVariants,
  unpurchasedProducts,
  legacyProductIds,
  firstVariantByProduct,
}: {
  unpurchasedVariants: readonly UnpurchasedVariant[]
  unpurchasedProducts: readonly UnpurchasedProduct[]
  legacyProductIds: ReadonlySet<number>
  firstVariantByProduct: ReadonlyMap<number, number>
}): CatalogPurchaseTarget[] {
  const targets = [
    ...unpurchasedVariants
      .filter(
        (variant) =>
          !legacyProductIds.has(variant.producto_id) ||
          firstVariantByProduct.get(variant.producto_id) !== variant.id,
      )
      .map((variant) => ({
        productName: variant.productName,
        productId: variant.producto_id,
        variantId: variant.id,
        target: {
          value: `v:${variant.producto_id}:${variant.id}`,
          label: `${variant.productName} · ${variant.nombre}`,
          sku: variant.sku ?? "",
        },
      })),
    ...unpurchasedProducts.map((product) => ({
      productName: product.nombre,
      productId: product.id,
      variantId: 0,
      target: { value: `p:${product.id}`, label: product.nombre, sku: product.sku ?? "" },
    })),
  ]
  return targets
    .sort(
      (left, right) =>
        left.productName.localeCompare(right.productName, "es", { sensitivity: "base" }) ||
        left.productId - right.productId ||
        left.variantId - right.variantId,
    )
    .map((item) => item.target)
}

// Incorpora al catálogo local un producto elegido desde la búsqueda remota, sin
// duplicar variantes, para que el selector y el autocompletado lo resuelvan.
export function mergeCatalogProduct(
  catalog: BusinessCostCatalogProduct[],
  product: BusinessCostCatalogProduct,
): BusinessCostCatalogProduct[] {
  const index = catalog.findIndex(
    (item) => !item.standalone_key && String(item.id) === String(product.id),
  )
  if (index < 0) {
    return [...catalog, product].sort((a, b) =>
      a.nombre.localeCompare(b.nombre, "es", { sensitivity: "base" }),
    )
  }
  const existing = catalog[index]
  const known = new Set((existing.producto_variantes ?? []).map((variant) => variant.id))
  const missing = (product.producto_variantes ?? []).filter((variant) => !known.has(variant.id))
  if (!missing.length) return catalog
  const merged = {
    ...existing,
    producto_variantes: [...(existing.producto_variantes ?? []), ...missing],
  }
  return catalog.map((item, position) => (position === index ? merged : item))
}
