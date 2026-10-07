import type { BusinessCostCatalogProduct } from "../supabase/queries/business-costs.ts"

export type CatalogScanMatch = {
  value: string
  productName: string
  variantName: string | null
  matchedBy: "barcode" | "sku"
}

// Escaneo en Compras: el código de barra exacto manda sobre el SKU (mismo
// orden que el armado). Devuelve el valor del selector de artículo
// (v:<producto>:<variante> o p:<producto> para legacy sin variantes).
export function findCatalogArticleByCode(
  catalog: readonly BusinessCostCatalogProduct[],
  code: string,
): CatalogScanMatch | null {
  const barcode = code.trim()
  const sku = barcode.toUpperCase()
  if (!barcode) return null
  const products = catalog.filter((product) => !product.standalone_key)
  for (const matchedBy of ["barcode", "sku"] as const) {
    const matches = (value: string | null | undefined) =>
      matchedBy === "barcode" ? value?.trim() === barcode : value?.trim().toUpperCase() === sku
    for (const product of products) {
      const variants = product.producto_variantes ?? []
      const variant = variants.find((item) => matches(matchedBy === "barcode" ? item.codigo_barra : item.sku))
      if (variant) return { value: `v:${product.id}:${variant.id}`, productName: product.nombre, variantName: variant.nombre, matchedBy }
      if (!variants.length && matches(matchedBy === "barcode" ? product.codigo_barra : product.sku)) {
        return { value: `p:${product.id}`, productName: product.nombre, variantName: null, matchedBy }
      }
    }
  }
  return null
}
