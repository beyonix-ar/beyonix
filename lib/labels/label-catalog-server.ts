import type { SupabaseClient } from "@supabase/supabase-js"

import { CATALOG_SEARCH_PAGE_SIZE, catalogSearchPattern, pageCatalogSearchHits, type CatalogSearchHit } from "../business/cost-catalog-search.ts"
import { collectAllRows, searchCatalogHits } from "../business/cost-catalog-server.ts"
import type { LabelCatalogProduct } from "./catalog.ts"

export const MAX_LABEL_CATALOG_IDS = 100

const PRODUCT_FIELDS =
  "id, nombre, activo, sku, codigo_barra, precio, venta_aleatoria, modo_color, producto_variantes(id, nombre, activo, stock, sku, color_hex, color_hex_secundario, codigo_barra, orden), catalog_barcode_aliases(barcode, variant_id)"

type VariantRow = {
  id: number
  nombre: string | null
  activo: boolean | null
  stock: number | null
  sku: string | null
  color_hex: string | null
  color_hex_secundario: string | null
  codigo_barra: string | null
  orden: number | null
}

type ProductRow = {
  id: number
  nombre: string | null
  activo: boolean | null
  sku: string | null
  codigo_barra: string | null
  precio: number | string | null
  venta_aleatoria: boolean | null
  modo_color: "especifico" | "aleatorio_simple" | "aleatorio_variantes" | null
  producto_variantes: VariantRow[] | null
  catalog_barcode_aliases: { barcode: string | null; variant_id: number | null }[] | null
}

type ProductNameRef = { nombre: string | null } | { nombre: string | null }[] | null

const embeddedName = (ref: ProductNameRef) => (Array.isArray(ref) ? ref[0]?.nombre : ref?.nombre) ?? ""
const toText = (value: string | null | undefined) => value?.trim() || null

function toLabelProduct(row: ProductRow): LabelCatalogProduct {
  const price = row.precio == null ? null : Number(row.precio)
  return {
    id: Number(row.id),
    name: row.nombre?.trim() ?? "",
    active: row.activo === true,
    sku: toText(row.sku),
    barcode: toText(row.codigo_barra),
    price: price != null && Number.isFinite(price) && price > 0 ? price : null,
    randomSale: row.venta_aleatoria === true,
    colorMode: row.modo_color,
    variants: [...(row.producto_variantes ?? [])]
      .sort((left, right) => (left.orden ?? 0) - (right.orden ?? 0) || left.id - right.id)
      .map((variant) => ({
        id: Number(variant.id),
        name: variant.nombre?.trim() ?? "",
        active: variant.activo === true,
        stock: variant.stock == null ? null : Number(variant.stock),
        sku: toText(variant.sku),
        colorHex: toText(variant.color_hex),
        colorHexSecondary: toText(variant.color_hex_secundario),
        barcode: toText(variant.codigo_barra),
      })),
    aliases: (row.catalog_barcode_aliases ?? [])
      .filter((alias) => alias.barcode?.trim())
      .map((alias) => ({ barcode: alias.barcode?.trim() ?? "", variantId: alias.variant_id == null ? null : Number(alias.variant_id) }))
      .sort((left, right) => left.barcode.localeCompare(right.barcode)),
  }
}

function check<T>({ data, error }: { data: T[] | null; error: { message: string } | null }) {
  if (error) throw new Error(error.message)
  return data ?? []
}

export async function loadLabelProductsByIds(admin: SupabaseClient, ids: readonly number[]) {
  const unique = [...new Set(ids)].filter((id) => Number.isSafeInteger(id) && id > 0).slice(0, MAX_LABEL_CATALOG_IDS)
  if (!unique.length) return []
  const rows = check<ProductRow>(await admin.from("productos").select(PRODUCT_FIELDS).in("id", unique))
  const byId = new Map(rows.map((row) => [Number(row.id), toLabelProduct(row)]))
  return unique.flatMap((id) => byId.get(id) ?? [])
}

// Igual que el selector de Compras (nombre, SKU, código de producto o
// variante, sin distinguir mayúsculas ni tildes) más los códigos equivalentes.
// La variante y el color se buscan por el nombre de la variante, que guarda el
// color ("NEGRO", "AZUL / ROSA").
export async function searchLabelCatalog(admin: SupabaseClient, query: string, offset: number) {
  const limit = CATALOG_SEARCH_PAGE_SIZE
  const pattern = catalogSearchPattern(query)
  if (!pattern) {
    const rows = check<ProductRow>(await admin.from("productos").select(PRODUCT_FIELDS).order("nombre").order("id").range(offset, offset + limit))
    return { items: rows.slice(0, limit).map(toLabelProduct), hasMore: rows.length > limit }
  }
  const [hits, aliasRows] = await Promise.all([
    searchCatalogHits(admin, query),
    collectAllRows<{ product_id: number; productos: ProductNameRef }>((from, to) =>
      admin.from("catalog_barcode_aliases").select("product_id, productos(nombre)").filter("barcode", "imatch", pattern).order("normalized_barcode").range(from, to),
    ),
  ])
  const page = pageCatalogSearchHits(
    [...hits, ...aliasRows.map((row): CatalogSearchHit => ({ id: Number(row.product_id), nombre: embeddedName(row.productos) }))],
    offset,
    limit,
  )
  return { items: await loadLabelProductsByIds(admin, page.ids), hasMore: page.hasMore }
}
