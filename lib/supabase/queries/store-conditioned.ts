import type { SupabaseClient } from "@supabase/supabase-js"

import type {
  SupabaseConditionedStock,
  SupabaseProducto,
} from "@/lib/supabase/types"

interface ConditionedCatalogRow {
  id: string
  product_id: number
  source_variant_id: number | null
  name: string
  sku: string
  color_hex: string
  images: unknown
  original_quantity: number
  sold_quantity: number
  available_quantity: number
  discount_percent: number
  reason: string | null
  approved_at: string
}

function toConditionedStock(
  row: ConditionedCatalogRow,
): SupabaseConditionedStock {
  return {
    id: String(row.id),
    product_id: Number(row.product_id),
    variant_id:
      row.source_variant_id == null
        ? null
        : Number(row.source_variant_id),
    original_quantity: Math.max(Number(row.original_quantity) || 0, 0),
    sold_quantity: Math.max(Number(row.sold_quantity) || 0, 0),
    quantity: Math.max(Number(row.available_quantity) || 0, 0),
    discount_percent: Math.max(Number(row.discount_percent) || 0, 0),
    reason: typeof row.reason === "string" ? row.reason : null,
    non_sellable_quantity: 0,
    non_sellable_reason: null,
    active: true,
    approved_at: String(row.approved_at),
    conditioned_name: typeof row.name === "string" ? row.name : null,
    conditioned_sku: typeof row.sku === "string" ? row.sku : null,
    conditioned_color_hex:
      typeof row.color_hex === "string" ? row.color_hex : null,
    conditioned_images: Array.isArray(row.images)
      ? row.images.filter(
          (image): image is string => typeof image === "string",
        )
      : [],
  }
}

export async function attachStoreConditionedStock(
  client: SupabaseClient,
  products: SupabaseProducto[],
) {
  const productIds = [...new Set(products.map((product) => product.id))]
  if (!productIds.length) return products

  const { data, error } = await client
    .from("conditioned_catalog_variants")
    .select(
      "id, product_id, source_variant_id, name, sku, color_hex, images, original_quantity, sold_quantity, available_quantity, discount_percent, reason, approved_at",
    )
    .in("product_id", productIds)
    .order("approved_at", { ascending: true })

  if (error) {
    if (
      /conditioned_catalog_variants|schema cache|does not exist/i.test(
        error.message,
      )
    ) {
      return products
    }
    throw error
  }

  const byProduct = new Map<number, SupabaseConditionedStock[]>()
  for (const rawRow of data ?? []) {
    const row = rawRow as unknown as ConditionedCatalogRow
    const item = toConditionedStock(row)
    byProduct.set(item.product_id, [
      ...(byProduct.get(item.product_id) ?? []),
      item,
    ])
  }

  return products.map((product) => ({
    ...product,
    conditioned_stock: byProduct.get(product.id) ?? [],
  }))
}
