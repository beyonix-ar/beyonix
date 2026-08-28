import "server-only"

import { createAdminClient } from "@/lib/supabase/admin"
import {
  buildProductCostLedgers,
  getWorstCaseKnownCost,
  resolveProductVariantCosts,
  type ProductCostLedgerRow,
  type VariantCostResolution,
} from "@/lib/business/product-costs"

export interface ProductKnownCost {
  knownUnitCost: number | null
  variantCosts: VariantCostResolution[]
}

/**
 * Trae de Supabase lo necesario (variantes del producto + libro de compras)
 * y delega la resolución en las funciones puras de
 * lib/business/product-costs.ts. Única fuente compartida entre el endpoint
 * de lectura (app/api/admin/products/[id]/pricing) y el de guardado
 * autoritativo (app/api/admin/products/[id]/catalog) -- nunca pueden
 * calcular el costo de forma distinta entre sí.
 */
export async function resolveProductKnownCost(
  admin: ReturnType<typeof createAdminClient>,
  productId: number,
): Promise<ProductKnownCost> {
  const [variantsResult, costRowsResult] = await Promise.all([
    admin
      .from("producto_variantes")
      .select("id, nombre")
      .eq("producto_id", productId),
    admin
      .from("product_cost_entries")
      .select("product_id, variant_id, purchase_date, quantity, total_cost")
      .eq("product_id", productId),
  ])

  if (variantsResult.error) {
    throw new Error("No se pudieron consultar las variantes del producto.")
  }
  if (costRowsResult.error) {
    throw new Error("No se pudo consultar el costo del producto.")
  }

  const ledgers = buildProductCostLedgers(
    (costRowsResult.data ?? []) as ProductCostLedgerRow[],
  )
  const variantCosts = resolveProductVariantCosts(
    ledgers,
    productId,
    variantsResult.data ?? [],
    new Date().toISOString(),
  )

  return { knownUnitCost: getWorstCaseKnownCost(variantCosts), variantCosts }
}
