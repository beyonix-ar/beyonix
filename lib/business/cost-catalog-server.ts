import type { SupabaseClient } from "@supabase/supabase-js"

import type {
  BusinessCostCatalogProduct,
  BusinessCostCatalogVariant,
  CatalogPurchaseTarget,
} from "../supabase/queries/business-costs.ts"
import {
  CATALOG_SEARCH_PAGE_SIZE,
  buildPendingPurchaseTargets,
  catalogSearchPattern,
  pageCatalogSearchHits,
  type CatalogSearchHit,
  type UnpurchasedProduct,
  type UnpurchasedVariant,
} from "./cost-catalog-search.ts"

// Tamaño de lote al recorrer resultados: igual o menor que el máximo de filas
// por respuesta de PostgREST, así ninguna consulta queda truncada en silencio.
const PAGE = 1000
const ID_CHUNK = 100

const PRODUCT_FIELDS =
  "id, nombre, activo, stock, sku, codigo_barra, producto_variantes(id, nombre, sku, activo, stock, color_hex, codigo_barra)"

type QueryResult<T> = { data: T[] | null; error: { message: string } | null }

type ProductRow = {
  id: number
  nombre: string | null
  activo: boolean | null
  stock: number | null
  sku: string | null
  codigo_barra: string | null
  producto_variantes: BusinessCostCatalogVariant[] | null
}

// Sin tipos generados, supabase-js infiere los embeds como arreglo aunque una
// relación muchos-a-uno llegue como objeto: se aceptan ambas formas.
type ProductNameRef = { nombre: string | null } | { nombre: string | null }[] | null

function embeddedName(ref: ProductNameRef) {
  return (Array.isArray(ref) ? ref[0]?.nombre : ref?.nombre) ?? ""
}

type BarcodeRef = { codigo_barra: string | null } | { codigo_barra: string | null }[] | null

const embeddedBarcode = (ref: BarcodeRef) =>
  (Array.isArray(ref) ? ref[0]?.codigo_barra : ref?.codigo_barra)?.trim() || null

// Historial de Compras: cada compra lleva el código de barra persistido de lo
// que se compró (la variante, o el producto si la compra no tiene variante).
export function withPurchaseBarcode<T extends { variant_id?: number | null }>({
  productos,
  producto_variantes,
  ...row
}: T & { productos?: BarcodeRef; producto_variantes?: BarcodeRef }) {
  return {
    ...row,
    barcode: row.variant_id != null ? embeddedBarcode(producto_variantes ?? null) : embeddedBarcode(productos ?? null),
  }
}

function ensure<T>({ data, error }: QueryResult<T>) {
  if (error) throw new Error(error.message)
  return data ?? []
}

// Recorre todas las páginas de una consulta ordenada; sin tope de filas.
export async function collectAllRows<T>(
  fetchPage: (from: number, to: number) => PromiseLike<QueryResult<T>>,
) {
  const rows: T[] = []
  for (let from = 0; ; from += PAGE) {
    const page = ensure(await fetchPage(from, from + PAGE - 1))
    rows.push(...page)
    if (page.length < PAGE) return rows
  }
}

function chunks<T>(items: readonly T[], size = ID_CHUNK) {
  const result: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size))
  }
  return result
}

function toCatalogProduct(row: ProductRow): BusinessCostCatalogProduct {
  return {
    id: Number(row.id),
    nombre: row.nombre ?? "",
    activo: row.activo === true,
    stock: row.stock,
    sku: row.sku,
    codigo_barra: row.codigo_barra,
    standalone_key: null,
    producto_variantes: [...(row.producto_variantes ?? [])].sort((left, right) => left.id - right.id),
  }
}

// Mismo respaldo que el catálogo de Compras para productos legacy sin SKU: el
// último SKU usado en una compra a nivel producto.
async function withLatestCostSku(admin: SupabaseClient, products: BusinessCostCatalogProduct[]) {
  const ids = products
    .filter((product) => !product.sku?.trim() && !product.producto_variantes?.length)
    .map((product) => Number(product.id))
  if (!ids.length) return products
  const rows = (
    await Promise.all(
      chunks(ids).map((chunk) =>
        collectAllRows<{ product_id: number; sku: string | null }>((from, to) =>
          admin
            .from("product_cost_entries")
            .select("product_id, sku")
            .in("product_id", chunk)
            .is("variant_id", null)
            .not("sku", "is", null)
            .order("purchase_date", { ascending: false })
            .order("created_at", { ascending: false })
            .order("id", { ascending: true })
            .range(from, to),
        ),
      ),
    )
  ).flat()
  const latest = new Map<number, string>()
  rows.forEach((row) => {
    const sku = row.sku?.trim()
    if (sku && !latest.has(Number(row.product_id))) latest.set(Number(row.product_id), sku)
  })
  return products.map((product) =>
    latest.has(Number(product.id)) && !product.sku?.trim()
      ? { ...product, sku: latest.get(Number(product.id)) ?? null }
      : product,
  )
}

export async function loadCatalogProductsByIds(
  admin: SupabaseClient,
  ids: readonly number[],
) {
  const unique = [...new Set(ids)].filter((id) => Number.isSafeInteger(id) && id > 0)
  if (!unique.length) return []
  const rows = (
    await Promise.all(
      chunks(unique).map(async (chunk) =>
        ensure<ProductRow>(await admin.from("productos").select(PRODUCT_FIELDS).in("id", chunk)),
      ),
    )
  ).flat()
  const byId = new Map(rows.map((row) => [Number(row.id), toCatalogProduct(row)]))
  return unique.flatMap((id) => {
    const product = byId.get(id)
    return product ? [product] : []
  })
}

// Coincidencias por nombre, SKU o código de barra (producto o variante); la
// comparten Compras y Etiquetas.
export async function searchCatalogHits(admin: SupabaseClient, query: string) {
  const pattern = catalogSearchPattern(query)
  const productHits = (column: string) =>
    collectAllRows<{ id: number; nombre: string | null }>((from, to) =>
      admin.from("productos").select("id, nombre").filter(column, "imatch", pattern).order("id").range(from, to),
    )
  const variantHits = (column: string) =>
    collectAllRows<{ producto_id: number; productos: ProductNameRef }>((from, to) =>
      admin
        .from("producto_variantes")
        .select("producto_id, productos(nombre)")
        .filter(column, "imatch", pattern)
        .order("id")
        .range(from, to),
    )
  const columns = ["nombre", "sku", "codigo_barra"]
  const [products, variants] = await Promise.all([
    Promise.all(columns.map(productHits)),
    Promise.all(columns.map(variantHits)),
  ])
  return [
    ...products.flat().map((row) => ({ id: Number(row.id), nombre: row.nombre ?? "" })),
    ...variants.flat().map((row) => ({ id: Number(row.producto_id), nombre: embeddedName(row.productos) })),
  ] satisfies CatalogSearchHit[]
}

// Selector manual de Compras: sin texto lista el catálogo por nombre en
// páginas; con texto busca por nombre, SKU o código de barra (de producto o de
// variante) sin distinguir mayúsculas ni tildes. Nunca devuelve el catálogo
// completo.
export async function searchCostCatalog(
  admin: SupabaseClient,
  query: string,
  offset: number,
) {
  const limit = CATALOG_SEARCH_PAGE_SIZE
  if (!catalogSearchPattern(query)) {
    const rows = ensure<ProductRow>(
      await admin
        .from("productos")
        .select(PRODUCT_FIELDS)
        .order("nombre")
        .order("id")
        .range(offset, offset + limit),
    )
    return {
      items: await withLatestCostSku(admin, rows.slice(0, limit).map(toCatalogProduct)),
      hasMore: rows.length > limit,
    }
  }
  const page = pageCatalogSearchHits(await searchCatalogHits(admin, query), offset, limit)
  return {
    items: await withLatestCostSku(admin, await loadCatalogProductsByIds(admin, page.ids)),
    hasMore: page.hasMore,
  }
}

// Artículos sin ninguna compra. Se resuelve con anti-joins en la base (sin
// traer el catálogo ni el historial completo) y considera todas las compras,
// no solo las cargadas en pantalla.
export async function loadPendingPurchaseTargets(
  admin: SupabaseClient,
): Promise<CatalogPurchaseTarget[]> {
  const [variantRows, productRows] = await Promise.all([
    collectAllRows<{ id: number; producto_id: number; nombre: string | null; sku: string | null; productos: ProductNameRef }>(
      (from, to) =>
        admin
          .from("producto_variantes")
          .select("id, producto_id, nombre, sku, productos(nombre), product_cost_entries(id)")
          .is("product_cost_entries", null)
          .order("id")
          .range(from, to),
    ),
    collectAllRows<{ id: number; nombre: string | null; sku: string | null }>((from, to) =>
      admin
        .from("productos")
        .select("id, nombre, sku, producto_variantes(id), product_cost_entries(id)")
        .is("producto_variantes", null)
        .is("product_cost_entries", null)
        .order("id")
        .range(from, to),
    ),
  ])
  const unpurchasedVariants: UnpurchasedVariant[] = variantRows.map((row) => ({
    id: Number(row.id),
    producto_id: Number(row.producto_id),
    nombre: row.nombre ?? "",
    sku: row.sku,
    productName: embeddedName(row.productos),
  }))
  const unpurchasedProducts: UnpurchasedProduct[] = productRows.map((row) => ({
    id: Number(row.id),
    nombre: row.nombre ?? "",
    sku: row.sku,
  }))

  const candidateIds = [...new Set(unpurchasedVariants.map((variant) => variant.producto_id))]
  const legacyProductIds = new Set(
    (
      await Promise.all(
        chunks(candidateIds).map((chunk) =>
          collectAllRows<{ product_id: number }>((from, to) =>
            admin
              .from("product_cost_entries")
              .select("product_id")
              .in("product_id", chunk)
              .is("variant_id", null)
              .order("id")
              .range(from, to),
          ),
        ),
      )
    )
      .flat()
      .map((row) => Number(row.product_id)),
  )
  const firstVariantByProduct = new Map<number, number>()
  ;(
    await Promise.all(
      chunks([...legacyProductIds]).map((chunk) =>
        collectAllRows<{ id: number; producto_id: number }>((from, to) =>
          admin
            .from("producto_variantes")
            .select("id, producto_id")
            .in("producto_id", chunk)
            .order("id")
            .range(from, to),
        ),
      ),
    )
  )
    .flat()
    .forEach((row) => {
      const productId = Number(row.producto_id)
      const current = firstVariantByProduct.get(productId)
      if (current == null || Number(row.id) < current) firstVariantByProduct.set(productId, Number(row.id))
    })

  return buildPendingPurchaseTargets({
    unpurchasedVariants,
    unpurchasedProducts,
    legacyProductIds,
    firstVariantByProduct,
  })
}
