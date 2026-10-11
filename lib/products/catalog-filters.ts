import type { SupabaseProducto } from "@/lib/supabase/types"
import { SITE_SETTINGS } from "../../config/site-settings.ts"
import { getProductColorMode } from "./color-mode.ts"
import { getProductVariantOptions } from "./product-variants.ts"
import { BASE_COLOR_ORDER, variantBaseColors } from "./product-color-filters.ts"

export const MULTICOLOR_FILTER = "multicolor"
export const RANDOM_COLOR_FILTER = "aleatorio"

export interface CatalogFilterValues {
  search: string
  sortBy: string
  selectedCategories: string[]
  selectedColors: string[]
  onlyOffers: boolean
  onlyBestSellers: boolean
  minPrice: number
  maxPrice: number
}

function activePhysicalVariants(product: SupabaseProducto) {
  return (product.producto_variantes ?? []).filter((variant) => variant.activo !== false)
}

export function getCustomerFilterColors(product: SupabaseProducto): string[] {
  if (getProductColorMode(product) !== "especifico") return [RANDOM_COLOR_FILTER]

  const variants = activePhysicalVariants(product)
  const sources = variants.length
    ? variants.map((variant) => ({ name: variant.nombre, colorHex: variant.color_hex, secondaryColorHex: variant.color_hex_secundario }))
    : getProductVariantOptions(product).filter((option) => !option.isRandom).map((option) => ({ name: option.name, colorHex: option.colorHex, secondaryColorHex: option.secondaryColorHex }))
  const colors = new Set<string>()
  for (const variant of sources) {
    variantBaseColors(variant).forEach((color) => colors.add(color))
    const first = variant.colorHex?.trim().toLowerCase()
    const second = variant.secondaryColorHex?.trim().toLowerCase()
    if (first && second && /^#[0-9a-f]{6}$/.test(first) && /^#[0-9a-f]{6}$/.test(second) && first !== second) {
      colors.add(MULTICOLOR_FILTER)
    }
  }
  return [...colors]
}

export function getAvailableCatalogColors(products: SupabaseProducto[]): string[] {
  const available = new Set(products.flatMap(getCustomerFilterColors))
  return [
    ...BASE_COLOR_ORDER.filter((color) => available.has(color)),
    ...[MULTICOLOR_FILTER, RANDOM_COLOR_FILTER].filter((color) => available.has(color)),
  ]
}

export function filterCatalogProducts(products: SupabaseProducto[], filters: CatalogFilterValues) {
  const search = filters.search.trim().toLowerCase()
  const matching = products.filter((product) =>
    (!SITE_SETTINGS.filters.showCategoryFilter || !filters.selectedCategories.length || filters.selectedCategories.includes(product.categorias?.slug ?? "")) &&
    (!SITE_SETTINGS.filters.showOfferFilter || !filters.onlyOffers || Boolean(product.precio_anterior)) &&
    (!SITE_SETTINGS.filters.showFeaturedFilter || !filters.onlyBestSellers || Boolean(product.destacado)) &&
    (!SITE_SETTINGS.filters.showPriceFilter || (product.precio >= filters.minPrice && product.precio <= filters.maxPrice)) &&
    (!filters.selectedColors.length || filters.selectedColors.some((color) => getCustomerFilterColors(product).includes(color))) &&
    product.nombre.toLowerCase().includes(search)
  )

  if (filters.sortBy === "price-asc") return matching.sort((a, b) => a.precio - b.precio)
  if (filters.sortBy === "price-desc") return matching.sort((a, b) => b.precio - a.precio)
  return matching
}
