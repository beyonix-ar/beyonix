import type { SupabaseClient } from "@supabase/supabase-js"

import type { CatalogCodeOwner, CatalogCodeStore } from "./catalog-lookup.ts"

const toId = (value: unknown) => {
  const id = Number(value)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}
const toText = (value: unknown) => (typeof value === "string" ? value : null)
const toStock = (value: unknown) => (value == null ? null : Number.isFinite(Number(value)) ? Number(value) : null)

function owner(row: { product_id?: unknown; variant_id?: unknown } | null): CatalogCodeOwner | null {
  return row ? { productId: toId(row.product_id), variantId: toId(row.variant_id) } : null
}

function check<T>({ data, error }: { data: T; error: { message: string } | null }) {
  if (error) throw new Error(error.message)
  return data
}

// Cada consulta va por clave única (PK de los registros de identidad o del
// producto/variante): no depende del tamaño del catálogo ni del límite de filas.
export function createSupabaseCatalogCodeStore(admin: SupabaseClient): CatalogCodeStore {
  return {
    async barcodeOwner(normalizedBarcode) {
      return owner(check(await admin
        .from("catalog_barcode_registry")
        .select("product_id, variant_id")
        .eq("normalized_barcode", normalizedBarcode)
        .maybeSingle()))
    },
    async aliasOwner(normalizedBarcode) {
      return owner(check(await admin
        .from("catalog_barcode_aliases")
        .select("product_id, variant_id")
        .eq("normalized_barcode", normalizedBarcode)
        .maybeSingle()))
    },
    async skuOwner(normalizedSku) {
      return owner(check(await admin
        .from("catalog_sku_registry")
        .select("product_id, variant_id")
        .eq("normalized_sku", normalizedSku)
        .maybeSingle()))
    },
    async variant(id) {
      const row = check(await admin
        .from("producto_variantes")
        .select("id, producto_id, nombre, activo, stock, sku, color_hex, codigo_barra")
        .eq("id", id)
        .maybeSingle())
      const variantId = toId(row?.id)
      const productId = toId(row?.producto_id)
      if (!row || !variantId || !productId) return null
      return {
        id: variantId,
        producto_id: productId,
        nombre: toText(row.nombre) ?? "",
        activo: row.activo === true,
        stock: toStock(row.stock),
        sku: toText(row.sku),
        color_hex: toText(row.color_hex),
        codigo_barra: toText(row.codigo_barra),
      }
    },
    async product(id) {
      const [productResult, variantsResult] = await Promise.all([
        admin
          .from("productos")
          .select("id, nombre, activo, stock, sku, codigo_barra, venta_aleatoria")
          .eq("id", id)
          .maybeSingle(),
        admin
          .from("producto_variantes")
          .select("id", { count: "exact", head: true })
          .eq("producto_id", id),
      ])
      const row = check(productResult)
      check(variantsResult)
      const productId = toId(row?.id)
      if (!row || !productId) return null
      return {
        id: productId,
        nombre: toText(row.nombre) ?? "",
        activo: row.activo === true,
        stock: toStock(row.stock),
        sku: toText(row.sku),
        codigo_barra: toText(row.codigo_barra),
        venta_aleatoria: row.venta_aleatoria === true,
        variantCount: variantsResult.count ?? 0,
      }
    },
    // Mismo respaldo que el catálogo de Compras para productos legacy sin SKU.
    async latestProductCostSku(productId) {
      const row = check(await admin
        .from("product_cost_entries")
        .select("sku")
        .eq("product_id", productId)
        .is("variant_id", null)
        .not("sku", "is", null)
        .neq("sku", "")
        .order("purchase_date", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle())
      return toText(row?.sku)?.trim() || null
    },
  }
}
