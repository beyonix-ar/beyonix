import { mergeCatalogProduct } from "../business/cost-catalog-search.ts"
import type { BusinessCostCatalogProduct } from "../supabase/queries/business-costs.ts"
import { getProductColorMode, type ProductColorMode } from "../products/color-mode.ts"

// Máximo que acepta el lector de Compras; los códigos del catálogo se guardan
// recortados a 64 y los SKU a 120.
export const MAX_SCAN_CODE_LENGTH = 128

export type CatalogCodeOwner = { productId: number | null; variantId: number | null }

export type CatalogLookupProduct = {
  id: number
  nombre: string
  activo: boolean
  stock: number | null
  sku: string | null
  codigo_barra: string | null
  /** Grupo comercial con venta aleatoria (el stock sigue siendo por variante). */
  venta_aleatoria?: boolean
  modo_color?: ProductColorMode | null
}

export type CatalogLookupVariant = {
  id: number
  producto_id: number
  nombre: string
  activo: boolean
  stock: number | null
  sku: string | null
  color_hex: string | null
  codigo_barra: string | null
}

export type CatalogCodeMatch = {
  value: string
  matchedBy: "barcode" | "sku" | "alias"
  product: CatalogLookupProduct
  variant: CatalogLookupVariant | null
  /**
   * El código identifica al grupo (p. ej. mismo EAN para todos los colores),
   * no a una variante física: hay que elegir cuál ingresa. `value` vacío.
   */
  requiresVariant?: boolean
}

// Acceso puntual a la base: cada método resuelve una fila por clave única
// (catalog_barcode_registry / catalog_sku_registry / PK), nunca el catálogo.
export interface CatalogCodeStore {
  /** Resolver transaccional compartido con el armado; detecta identidades ambiguas. */
  codeTarget?(code: string): Promise<(CatalogCodeOwner & { matchedBy: CatalogCodeMatch["matchedBy"] }) | null>
  barcodeOwner(normalizedBarcode: string): Promise<CatalogCodeOwner | null>
  /** Códigos de barra equivalentes (catalog_barcode_aliases). */
  aliasOwner(normalizedBarcode: string): Promise<CatalogCodeOwner | null>
  skuOwner(normalizedSku: string): Promise<CatalogCodeOwner | null>
  variant(id: number): Promise<CatalogLookupVariant | null>
  product(id: number): Promise<(CatalogLookupProduct & { variantCount: number; soleVariantId?: number | null }) | null>
  latestProductCostSku(productId: number): Promise<string | null>
}

function productFields({ id, nombre, activo, stock, sku, codigo_barra, venta_aleatoria, modo_color }: CatalogLookupProduct): CatalogLookupProduct {
  return {
    id, nombre, activo, stock, sku, codigo_barra,
    ...(venta_aleatoria === true ? { venta_aleatoria: true } : {}),
    ...(modo_color ? { modo_color } : {}),
  }
}

async function resolveOwner(
  store: CatalogCodeStore,
  owner: CatalogCodeOwner,
  matchedBy: CatalogCodeMatch["matchedBy"],
): Promise<CatalogCodeMatch | null> {
  if (owner.variantId != null) {
    const variant = await store.variant(owner.variantId)
    const product = variant && await store.product(variant.producto_id)
    if (!variant || !product) return null
    return { value: `v:${product.id}:${variant.id}`, matchedBy, product: productFields(product), variant }
  }
  if (owner.productId == null) return null
  const product = await store.product(owner.productId)
  if (!product) return null
  if (getProductColorMode(product) === "aleatorio_simple" && product.variantCount === 1 && product.soleVariantId != null) {
    const variant = await store.variant(product.soleVariantId)
    if (!variant || variant.producto_id !== product.id) return null
    return { value: `v:${product.id}:${variant.id}`, matchedBy, product: productFields(product), variant }
  }
  // Un producto con variantes se compra siempre por variante: su código o SKU
  // propio no identifica qué variante ingresa. Un alias de grupo lo informa
  // para que Compras pida elegir la variante física.
  if (product.variantCount > 0 && matchedBy === "alias") {
    return { value: "", matchedBy, product: productFields(product), variant: null, requiresVariant: true }
  }
  if (product.variantCount > 0) return null
  return {
    value: `p:${product.id}`,
    matchedBy,
    product: { ...productFields(product), sku: product.sku ?? await store.latestProductCostSku(product.id) },
    variant: null,
  }
}

// Escaneo en Compras: el código de barra exacto manda sobre el SKU (mismo
// orden que el armado). Devuelve el valor del selector de artículo
// (v:<producto>:<variante> o p:<producto> para legacy sin variantes).
export async function findCatalogArticleByCode(
  store: CatalogCodeStore,
  code: string,
): Promise<CatalogCodeMatch | null> {
  const barcode = code.trim()
  if (!barcode || barcode.length > MAX_SCAN_CODE_LENGTH) return null
  if (store.codeTarget) {
    const target = await store.codeTarget(barcode)
    return target && resolveOwner(store, target, target.matchedBy)
  }
  const barcodeOwner = await store.barcodeOwner(barcode)
  const byBarcode = barcodeOwner && await resolveOwner(store, barcodeOwner, "barcode")
  if (byBarcode) return byBarcode
  const aliasOwner = await store.aliasOwner(barcode)
  const byAlias = aliasOwner && await resolveOwner(store, aliasOwner, "alias")
  if (byAlias) return byAlias
  const skuOwner = await store.skuOwner(barcode.toUpperCase())
  return skuOwner && resolveOwner(store, skuOwner, "sku")
}

// El catálogo de Compras puede no traer el artículo escaneado; se incorpora
// para que el selector y el autocompletado lo resuelvan igual que al elegirlo.
export function mergeCatalogMatch(
  catalog: BusinessCostCatalogProduct[],
  { product, variant }: CatalogCodeMatch,
): BusinessCostCatalogProduct[] {
  return mergeCatalogProduct(catalog, {
    ...product,
    standalone_key: null,
    producto_variantes: variant
      ? [{
          id: variant.id,
          nombre: variant.nombre,
          activo: variant.activo,
          stock: variant.stock,
          sku: variant.sku,
          color_hex: variant.color_hex,
          codigo_barra: variant.codigo_barra,
        }]
      : [],
  })
}
